"""Change detection and email composition for the notification service.

A job's status is derived on every read (workflow.status.compute_job_status)
and its cases' states come from annotation-service's own writes, so there
is no single place a "status changed" event could be raised from.
Instead `run_cycle` re-derives assignee/status/case states for every
Annotation/Review card, compares them with the last snapshot stored in
job_notification_state, and emails whoever the difference concerns --
the observer model. Whatever caused the change (a save in ct-annotator,
a reviewer's decision, a board edit) is picked up the same way.

Only job-level changes are emailed -- a job assigned to someone and a
job's status moving -- never individual cases: an annotator working
through a queue would otherwise get a message per case, and a
reviewer one per submission. The per-case states are still observed
and stored (job_notification_state.case_states) so the picture is
complete, they just don't generate mail.
"""
import html as html_lib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from shared_models.models import (
    JobNotificationState,
    NotificationLog,
    NotificationPreference,
    NotificationSettings,
    Study,
    WorkflowCard,
    WorkflowCardType,
)

from app.api.workflow.status import _annotation_progress, compute_job_status, job_case_states
from app.keycloak_admin import get_user

from .mailer import send_email

log = logging.getLogger(__name__)

STATUS_LABELS = {"todo": "To do", "in_progress": "In progress", "done": "Done"}
STATUS_COLORS = {"todo": ("#fee2e2", "#b91c1c"), "in_progress": ("#dbeafe", "#1d4ed8"), "done": ("#d1fae5", "#047857")}

# What a job's current status actually means and what the recipient
# should do about it, per card type. Keyed on the status *after* the
# event (job_assigned and job_status_changed both end with the job in
# some status, and that's what the reader needs to act on) -- every
# email spells this out so nobody has to guess what a "job assigned" or
# "now In progress" email is asking of them.
_GUIDANCE = {
    (WorkflowCardType.ANNOTATION, "todo"): (
        "None of the cases in this job have been annotated yet.",
        "Open My Jobs and start annotating the cases.",
    ),
    (WorkflowCardType.ANNOTATION, "in_progress"): (
        "Some cases still need attention -- either nobody has annotated them yet, or a reviewer sent them back for rework.",
        "Open My Jobs, finish the remaining cases and fix anything that was sent back.",
    ),
    (WorkflowCardType.ANNOTATION, "done"): (
        "Every case in this job has been annotated.",
        "Nothing to do -- the job is complete. You'll hear again only if a reviewer sends a case back.",
    ),
    (WorkflowCardType.REVIEW, "todo"): (
        "No cases have been submitted for your review yet.",
        "Nothing to do right now -- you'll get another email as soon as a case is ready for you.",
    ),
    (WorkflowCardType.REVIEW, "in_progress"): (
        "At least one case in this job is awaiting your decision.",
        "Open My Jobs and review the pending case(s) -- approve them or send them back with a comment.",
    ),
    (WorkflowCardType.REVIEW, "done"): (
        "Every case in this job has been approved or sent back -- there's nothing left pending.",
        "Nothing to do -- the job is complete.",
    ),
}


def _guidance(card_type: WorkflowCardType, status: str) -> tuple[str, str]:
    return _GUIDANCE.get((card_type, status), ("This job's status changed.", "Open My Jobs to see what's going on."))


@dataclass
class Snapshot:
    assigned_user_id: str | None
    status: str
    case_states: dict[str, str] = field(default_factory=dict)


@dataclass
class Event:
    kind: str  # "job_assigned" | "job_status_changed"
    user_id: str
    details: dict = field(default_factory=dict)


def diff_snapshots(previous: Snapshot | None, current: Snapshot) -> list[Event]:
    """The pure heart of the service: what changed between two snapshots
    of one card, and who to tell. Split out from the DB/SMTP plumbing so
    it can be unit-tested with plain data.

    - No previous snapshot (a brand-new card) with an assignee -> that
      person got a new job.
    - Assignee changed -> the new assignee got a new job (the previous
      one is simply no longer told about this card).
    - Same assignee, status changed -> tell them.
    Nothing else: case-level changes deliberately don't email (see the
    module docstring)."""
    user = current.assigned_user_id
    if user is None:
        return []
    if previous is None or previous.assigned_user_id != user:
        return [Event("job_assigned", user, {"status": current.status})]
    if previous.status != current.status:
        return [Event("job_status_changed", user, {"from": previous.status, "to": current.status})]
    return []


@dataclass
class CardContext:
    """Everything an email needs to draw the job card, resolved once per
    card by run_cycle."""

    card: WorkflowCard
    study_name: str | None
    status: str
    annotated: int
    total: int


def _pill(label: str, colors: tuple[str, str]) -> str:
    bg, fg = colors
    return (
        f'<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:{bg};color:{fg};'
        f'font-size:12px;font-weight:600;line-height:18px">{html_lib.escape(label)}</span>'
    )


def _card_html(ctx: CardContext, headline: str, lead: str, meaning: str, action: str) -> str:
    """The email body as a job card -- the same shape as the My Jobs
    card: type stripe, title, study, status pill, progress bar -- plus a
    plain-language "what this means / what to do" box, so the email is
    useful without having to click through and guess. Inline CSS only
    (email clients strip stylesheets), no images, no links: the card
    *is* the information."""
    is_review = ctx.card.type == WorkflowCardType.REVIEW
    accent = "#7c3aed" if is_review else "#2563eb"
    kind = "Review job" if is_review else "Annotation job"
    status_label = STATUS_LABELS.get(ctx.status, ctx.status)
    pct = 0 if ctx.total == 0 else round(100 * ctx.annotated / ctx.total)
    progress_word = "decided" if is_review else "annotated"
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
  <tr><td style="padding:0 4px 14px;font-size:13px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;font-weight:600">VoxelLabel</td></tr>
  <tr><td style="padding:0 4px 18px;font-size:20px;font-weight:700;color:#111827">{html_lib.escape(headline)}</td></tr>
  <tr><td style="padding:0 4px 18px;font-size:15px;line-height:22px;color:#374151">{html_lib.escape(lead)}</td></tr>
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)">
      <tr>
        <td width="6" style="background:{accent}"></td>
        <td style="padding:18px 20px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{accent}">{kind}</div>
          <div style="font-size:18px;font-weight:700;color:#111827;margin-top:4px">{html_lib.escape(ctx.card.title)}</div>
          <div style="font-size:13px;color:#6b7280;margin-top:2px">{html_lib.escape(ctx.study_name or "")}</div>
          <div style="margin-top:12px">{_pill(status_label, STATUS_COLORS.get(ctx.status, ("#f3f4f6", "#4b5563")))}
            <span style="font-size:12px;color:#6b7280;margin-left:8px">{ctx.annotated} of {ctx.total} cases {progress_word}</span></div>
          <div style="margin-top:10px;height:6px;border-radius:999px;background:#e5e7eb"><div style="height:6px;width:{pct}%;border-radius:999px;background:{accent}"></div></div>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:14px 4px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px">
      <tr><td style="padding:14px 18px">
        <div style="font-size:12px;color:#374151;line-height:19px"><b style="color:#111827">What this means:</b> {html_lib.escape(meaning)}</div>
        <div style="font-size:12px;color:#374151;line-height:19px;margin-top:6px"><b style="color:#111827">What to do:</b> {html_lib.escape(action)}</div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:18px 4px 0;font-size:12px;line-height:18px;color:#9ca3af">You're getting this because the job is assigned to you. Open VoxelLabel and go to My Jobs to work on it -- that's also where you can switch these emails off.</td></tr>
</table>
</td></tr></table>
</body></html>"""


def compose(event: Event, ctx: CardContext) -> tuple[str, str, str]:
    """Subject, plain-text body and HTML body for one event. Every email
    spells out, in plain language, what the current status means and
    what the recipient is expected to do about it (see _guidance) -- not
    just that something changed. No links anywhere -- the email carries
    the job card itself; My Jobs is where the work is, and the person
    knows where the platform lives."""
    kind_label = "review" if ctx.card.type == WorkflowCardType.REVIEW else "annotation"
    where = f"{ctx.card.title} ({ctx.study_name})" if ctx.study_name else ctx.card.title
    status_label = STATUS_LABELS.get(ctx.status, ctx.status)
    progress_word = "decided" if ctx.card.type == WorkflowCardType.REVIEW else "annotated"
    meaning, action = _guidance(ctx.card.type, ctx.status)
    card_text = (
        f"\n\n  {'Review' if kind_label == 'review' else 'Annotation'} job: {ctx.card.title}\n"
        f"  Study: {ctx.study_name or '-'}\n  Status: {status_label} · {ctx.annotated} of {ctx.total} cases {progress_word}"
    )
    guidance_text = f"\n\n  What this means: {meaning}\n  What to do: {action}"
    footer = "\n\nYou're getting this because the job is assigned to you. Open VoxelLabel > My Jobs to work on it -- that's also where you can switch these emails off."

    if event.kind == "job_assigned":
        headline = f"New {kind_label} job for you"
        lead = f"{where} has been assigned to you."
        body = lead + card_text + guidance_text + footer
        return (f"New {kind_label} job: {where}", body, _card_html(ctx, headline, lead, meaning, action))

    if event.kind == "job_status_changed":
        to_label = STATUS_LABELS.get(event.details["to"], event.details["to"])
        from_label = STATUS_LABELS.get(event.details["from"], event.details["from"])
        headline = f"Job now {to_label}"
        lead = f'Your {kind_label} job {where} moved from "{from_label}" to "{to_label}".'
        body = lead + card_text + guidance_text + footer
        return (f"Job status: {where} is now {to_label}", body, _card_html(ctx, headline, lead, meaning, action))

    raise ValueError(f"unknown event kind {event.kind}")


def get_settings(db: Session) -> NotificationSettings:
    """The single settings row, created with defaults on first use."""
    row = db.get(NotificationSettings, 1)
    if row is None:
        row = NotificationSettings(id=1)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _preference_allows(pref: NotificationPreference | None, kind: str) -> bool:
    if pref is None:
        return True
    if not pref.email_enabled:
        return False
    return {
        "job_assigned": pref.notify_new_job,
        "job_status_changed": pref.notify_status_change,
    }.get(kind, True)


def _snapshot_of(db: Session, card: WorkflowCard) -> Snapshot:
    return Snapshot(
        assigned_user_id=card.config.get("assigned_user_id") or None,
        status=compute_job_status(db, card),
        case_states=job_case_states(db, card),
    )


def run_cycle(db: Session) -> dict:
    """One observation pass over every Annotation/Review card. Returns a
    small summary for the admin UI's status card and logs. Emails are
    only *sent* when delivery is enabled; the events are still detected,
    logged as "skipped" and the snapshot advanced either way, so turning
    delivery on later doesn't replay every change since the beginning."""
    settings = get_settings(db)
    cards = (
        db.query(WorkflowCard)
        .filter(WorkflowCard.type.in_([WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW]))
        .order_by(WorkflowCard.created_at)
        .all()
    )
    states = {s.card_id: s for s in db.query(JobNotificationState).all()}
    # First ever run: record where things stand without mailing about all
    # of history as if it had just happened.
    bootstrap = len(states) == 0
    now = datetime.now(timezone.utc)

    studies = {s.id: s.name for s in db.query(Study).filter(Study.id.in_({c.study_id for c in cards})).all()} if cards else {}
    prefs = {p.user_id: p for p in db.query(NotificationPreference).all()}
    email_cache: dict[str, str | None] = {}
    summary = {"cards": len(cards), "events": 0, "sent": 0, "skipped": 0, "failed": 0, "bootstrap": bootstrap}

    def email_for(user_id: str) -> str | None:
        if user_id not in email_cache:
            try:
                email_cache[user_id] = get_user(user_id).get("email") or None
            except Exception as err:  # Keycloak down / user gone -- treat as "no address", don't abort the cycle
                log.warning("notification service: couldn't resolve email for %s: %s", user_id, err)
                email_cache[user_id] = None
        return email_cache[user_id]

    for card in cards:
        current = _snapshot_of(db, card)
        state = states.get(card.id)
        previous = Snapshot(state.assigned_user_id, state.status, dict(state.case_states or {})) if state else None
        events = [] if bootstrap else diff_snapshots(previous, current)

        if events:
            is_review = card.type == WorkflowCardType.REVIEW
            progress = _annotation_progress(db, card.output_case_ids or [], review=is_review, since=None if is_review else card.created_at)
            ctx = CardContext(
                card=card,
                study_name=studies.get(card.study_id),
                status=current.status,
                annotated=progress["annotated"],
                total=progress["total"],
            )
        for event in events:
            summary["events"] += 1
            subject, text, html = compose(event, ctx)
            entry = NotificationLog(
                user_id=event.user_id, event_type=event.kind, card_id=card.id, subject=subject, body=text, status="skipped"
            )
            pref = prefs.get(event.user_id)
            if not settings.enabled:
                entry.error = "email delivery is switched off"
            elif not _preference_allows(pref, event.kind):
                entry.error = "the user opted out of this kind of email"
            else:
                address = email_for(event.user_id)
                entry.email = address
                if not address:
                    entry.error = "no email address on the user's account"
                else:
                    try:
                        send_email(settings, address, subject, text, html)
                        entry.status = "sent"
                    except Exception as err:
                        entry.status = "failed"
                        entry.error = str(err)[:2000]
                        log.warning("notification service: sending to %s failed: %s", address, err)
            summary[entry.status] += 1
            db.add(entry)

        if state is None:
            db.add(
                JobNotificationState(
                    card_id=card.id,
                    assigned_user_id=current.assigned_user_id,
                    status=current.status,
                    case_states=current.case_states,
                    observed_at=now,
                )
            )
        else:
            state.assigned_user_id = current.assigned_user_id
            state.status = current.status
            state.case_states = current.case_states
            state.observed_at = now

    # Cards that no longer exist: the FK cascade handles deletion, but a
    # stale row for a card whose type was changed away would linger.
    live_ids = {c.id for c in cards}
    for card_id, state in states.items():
        if card_id not in live_ids:
            db.delete(state)

    db.commit()
    return summary
