"""Email composition for the self-service registration flow -- a small
sibling to events.py's job-change emails, kept separate because these
concern an account request, not a workflow card. Deliberately plainer
than the job-card emails (no progress bars, no status pills): there's
nothing to visualize here, just who's asking and what happened.

No links, matching the rest of the notification service's mail -- the
platform address is given as plain text people can copy."""
import html as html_lib

from shared_models.models import RegistrationRequest


def _shell(headline: str, body_html: str) -> str:
    """The plain notice-email shell every registration email uses:
    VoxelLabel eyebrow, a headline, then whatever body the caller
    supplies. Inline CSS only -- email clients strip stylesheets."""
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
  <tr><td style="padding:0 4px 14px;font-size:13px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;font-weight:600">VoxelLabel</td></tr>
  <tr><td style="padding:0 4px 18px;font-size:20px;font-weight:700;color:#111827">{html_lib.escape(headline)}</td></tr>
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)">
      <tr><td style="padding:20px 22px;font-size:14px;line-height:22px;color:#374151">{body_html}</td></tr>
    </table>
  </td></tr>
</table>
</td></tr></table>
</body></html>"""


def compose_admin_alert(req: RegistrationRequest, platform_url: str) -> tuple[str, str, str]:
    """Sent to every global admin when someone submits the public
    registration form."""
    name = f"{req.first_name} {req.last_name}"
    note_line = f"\n  Note from them: {req.note}" if req.note else ""
    text = (
        f"{name} ({req.email}, username \"{req.username}\") asked for a VoxelLabel account.{note_line}\n\n"
        f"Open VoxelLabel > Users > Registration requests to approve or decline it."
    )
    note_html = f'<div style="margin-top:10px;padding:10px 12px;background:#f9fafb;border-radius:8px;font-size:13px;color:#4b5563">"{html_lib.escape(req.note)}"</div>' if req.note else ""
    body_html = (
        f'<div><b>{html_lib.escape(name)}</b> ({html_lib.escape(req.email)}) asked for a VoxelLabel account -- '
        f'requested username <b>{html_lib.escape(req.username)}</b>.</div>{note_html}'
        f'<div style="margin-top:14px;font-size:12px;color:#9ca3af">Open VoxelLabel ({html_lib.escape(platform_url)}) '
        f'&gt; Users &gt; Registration requests to approve or decline it.</div>'
    )
    return (f"New account request: {name}", text, _shell("New account request", body_html))


def compose_received(req: RegistrationRequest, platform_url: str) -> tuple[str, str, str]:
    """Sent to the requester right after they submit the form -- so they
    know it went somewhere and isn't just waiting on a broken form."""
    text = (
        f"Thanks, {req.first_name} -- your request for a VoxelLabel account has been received.\n\n"
        f"An administrator needs to approve it before you can sign in. You'll get another email either way."
    )
    body_html = (
        f"<div>Thanks, {html_lib.escape(req.first_name)} -- your request for a VoxelLabel account has been received.</div>"
        f'<div style="margin-top:10px">An administrator needs to approve it before you can sign in. '
        f"You'll get another email either way.</div>"
    )
    return ("Your VoxelLabel account request was received", text, _shell("Request received", body_html))


def compose_approved(req: RegistrationRequest, username: str, temporary_password: str, platform_url: str) -> tuple[str, str, str]:
    """Sent on approval, with the one-time credentials -- the same
    "temporary password, choose your own at first login" pattern the
    admin's manual "create user" flow already uses."""
    text = (
        f"Good news, {req.first_name} -- your VoxelLabel account was approved.\n\n"
        f"  Username: {username}\n  Temporary password: {temporary_password}\n\n"
        f"You'll be asked to choose your own password the first time you sign in. "
        f"Open VoxelLabel at {platform_url}."
    )
    body_html = (
        f"<div>Good news, {html_lib.escape(req.first_name)} -- your VoxelLabel account was approved.</div>"
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;font-size:13px">'
        f'<tr><td style="color:#6b7280;padding:2px 10px 2px 0">Username</td><td style="font-weight:600;color:#111827">{html_lib.escape(username)}</td></tr>'
        f'<tr><td style="color:#6b7280;padding:2px 10px 2px 0">Temporary password</td><td style="font-weight:600;color:#111827;font-family:ui-monospace,Menlo,monospace">{html_lib.escape(temporary_password)}</td></tr>'
        f"</table>"
        f'<div style="margin-top:14px">You\'ll be asked to choose your own password the first time you sign in.</div>'
        f'<div style="margin-top:6px;font-size:12px;color:#9ca3af">Open VoxelLabel at {html_lib.escape(platform_url)}.</div>'
    )
    return ("Your VoxelLabel account is ready", text, _shell("Account approved", body_html))


def compose_rejected(req: RegistrationRequest, reason: str | None) -> tuple[str, str, str]:
    """Sent on rejection -- a plain, non-judgmental decline, with the
    admin's reason if one was given."""
    reason_line = f"\n\n  Reason given: {reason}" if reason else ""
    text = f"Hi {req.first_name} -- your request for a VoxelLabel account was not approved.{reason_line}"
    reason_html = (
        f'<div style="margin-top:10px;padding:10px 12px;background:#f9fafb;border-radius:8px;font-size:13px;color:#4b5563">{html_lib.escape(reason)}</div>'
        if reason
        else ""
    )
    body_html = f"<div>Hi {html_lib.escape(req.first_name)} -- your request for a VoxelLabel account was not approved.</div>{reason_html}"
    return ("Your VoxelLabel account request", text, _shell("Request declined", body_html))
