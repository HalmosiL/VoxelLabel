"""Pure aggregation behind a study's analytics page: what happened to
every case of one study as it went through the workflow -- rounds of
annotation and review, what was drawn, who did it and how long it took.
No database and no clock: api.py loads plain rows and passes them in, so
tests/test_study_analytics.py can pin every figure down.

Two review flows write the same tables differently, and both count:

- the viewer's per-object review saves the *reviewer's* own version of
  the annotation and puts the decision on that row (its status flips to
  approved/rejected, its annotator_id is the reviewer);
- the admin-ui's whole-annotation review decides on the annotator's
  submitted row itself.

So a *submission* is a row an annotator sent for review: status
submitted/approved/rejected, and not a row whose own reviewer wrote it.
A *decision* is an AnnotationReview row. Everything below is built from
those two sequences per case, in time order.

Inputs (all plain dicts):
  annotations: {id, case_id, annotator_id, status, created_at, payload}
  reviews:     {annotation_id, reviewer_id, decision ("approve"|"reject"), created_at}
  legs:        pipeline_health legs (card_id, card_type, case_id, assignee_id,
               actor_id, queue_start, first_touch, terminal_at, queue_ms, work_ms)
  effort:      usage.stats.case_effort entries (job_id, case_id, user_ids,
               sittings, active_ms, undos, first_input_ms)
  stage:       {card_id, case_id, occurred_at} -- when a case entered a card
  cards:       {id, type, title}
"""
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import median

SUBMITTED_STATUSES = ("submitted", "approved", "rejected")


def _ms(delta: timedelta) -> int:
    return int(delta.total_seconds() * 1000)


def _med(values: list) -> int | None:
    values = [v for v in values if v is not None]
    return int(median(values)) if values else None


def _status(value) -> str:
    return getattr(value, "value", value)


def case_histories(annotations: list[dict], reviews: list[dict]) -> dict[str, dict]:
    """Per case: its submissions and decisions in time order, and the
    reviewed rows (whose payload carries the reviewer's per-object
    verdicts)."""
    reviewers_of: dict = defaultdict(set)
    decisions_by_row: dict = defaultdict(list)
    for r in reviews:
        reviewers_of[r["annotation_id"]].add(r["reviewer_id"])
        decisions_by_row[r["annotation_id"]].append(r)
    cases: dict[str, dict] = defaultdict(lambda: {"submissions": [], "decisions": [], "drafts": [], "reviewed_rows": []})
    for a in sorted(annotations, key=lambda a: a["created_at"]):
        h = cases[a["case_id"]]
        own_review = a["annotator_id"] in reviewers_of.get(a["id"], set())
        if _status(a["status"]) in SUBMITTED_STATUSES and not own_review:
            h["submissions"].append(a)
        elif _status(a["status"]) == "draft" and not own_review:
            h["drafts"].append(a)
        for d in decisions_by_row.get(a["id"], []):
            h["decisions"].append({**d, "case_id": a["case_id"], "row": a})
        if a["id"] in decisions_by_row:
            h["reviewed_rows"].append(a)
    for h in cases.values():
        h["decisions"].sort(key=lambda d: d["created_at"])
        # a reviewer's version saved mid-review (no decision on it yet)
        # is review work, not an annotator's draft
        reviewers = {d["reviewer_id"] for d in h["decisions"]}
        h["drafts"] = [a for a in h["drafts"] if a["annotator_id"] not in reviewers]
    return dict(cases)


def case_state(h: dict) -> str:
    """approved | sent_back | awaiting_review | in_progress | not_started,
    from the latest submission and decision."""
    last_sub = h["submissions"][-1]["created_at"] if h["submissions"] else None
    last_dec = h["decisions"][-1] if h["decisions"] else None
    if last_sub is not None and (last_dec is None or last_sub > last_dec["created_at"]):
        return "awaiting_review"
    if last_dec is not None:
        if last_dec["decision"] == "approve":
            return "approved"
        return "in_progress" if any(d["created_at"] > last_dec["created_at"] for d in h["drafts"]) else "sent_back"
    return "in_progress" if h["drafts"] else "not_started"


def _labels_of(payload: dict | None) -> dict:
    return {lab.get("id"): lab.get("name") or f"Label {lab.get('id')}" for lab in (payload or {}).get("labels") or []}


def objects_by_label(payload: dict | None) -> Counter:
    names = _labels_of(payload)
    return Counter(names.get(o.get("label_id"), "Unlabelled") for o in (payload or {}).get("objects") or [])


def cases_table(
    histories: dict[str, dict],
    stage: list[dict],
    effort: list[dict],
    card_types: dict[str, str],
    titles: dict[str, str],
    names: dict[str, str],
) -> list[dict]:
    """One row per case that entered the workflow or was annotated: its
    state, rounds, rework, lead time, hands-on time on each side, who
    worked on it and what was drawn."""
    entered: dict[str, datetime] = {}
    for s in stage:
        if card_types.get(s["card_id"]) == "annotation":
            prev = entered.get(s["case_id"])
            entered[s["case_id"]] = s["occurred_at"] if prev is None or s["occurred_at"] < prev else prev
    hands_on: dict[tuple[str, str], int] = defaultdict(int)
    for e in effort:
        kind = card_types.get(e["job_id"])
        if kind in ("annotation", "review"):
            hands_on[(e["case_id"], kind)] += e["active_ms"]

    rows = []
    for case_id in sorted(set(histories) | set(entered)):
        h = histories.get(case_id) or {"submissions": [], "decisions": [], "drafts": [], "reviewed_rows": []}
        approvals = [d for d in h["decisions"] if d["decision"] == "approve"]
        approved_at = approvals[0]["created_at"] if approvals else None
        own_rows = sorted(h["drafts"] + h["submissions"], key=lambda a: a["created_at"])
        # the case's start: entering an Annotation card, or (a case annotated
        # outside the board) its first saved version
        start = entered.get(case_id) or (own_rows[0]["created_at"] if own_rows else None)
        latest = h["submissions"][-1] if h["submissions"] else (h["drafts"][-1] if h["drafts"] else None)
        drawn = objects_by_label(latest["payload"]) if latest else Counter()
        rows.append(
            {
                "case_id": case_id,
                "case_title": titles.get(case_id),
                "state": case_state(h),
                "rounds": len(h["submissions"]),
                "sent_back": sum(1 for d in h["decisions"] if d["decision"] == "reject"),
                "first_pass": (h["decisions"][0]["decision"] == "approve") if h["decisions"] else None,
                "entered_at": start,
                "approved_at": approved_at,
                "lead_time_ms": _ms(approved_at - start) if approved_at and start and approved_at >= start else None,
                "annotate_ms": hands_on.get((case_id, "annotation"), 0),
                "review_ms": hands_on.get((case_id, "review"), 0),
                "annotators": sorted({names.get(a["annotator_id"], a["annotator_id"]) for a in h["submissions"] + h["drafts"]}),
                "reviewers": sorted({names.get(d["reviewer_id"], d["reviewer_id"]) for d in h["decisions"]}),
                "objects": sum(drawn.values()),
                "labels": dict(drawn),
            }
        )
    order = {"sent_back": 0, "awaiting_review": 1, "in_progress": 2, "not_started": 3, "approved": 4}
    rows.sort(key=lambda r: (order[r["state"]], -(r["rounds"] or 0), r["case_title"] or r["case_id"]))
    return rows


def label_table(histories: dict[str, dict]) -> list[dict]:
    """Per label (by name, across the study): objects drawn in the
    latest submission of each case, cases it appears in, and -- from the
    reviewers' per-object verdicts -- how often objects of that label
    were rejected and why."""
    drawn: Counter = Counter()
    in_cases: Counter = Counter()
    accepted: Counter = Counter()
    rejected: Counter = Counter()
    reasons: dict[str, Counter] = defaultdict(Counter)
    for h in histories.values():
        if h["submissions"]:
            counts = objects_by_label(h["submissions"][-1]["payload"])
            drawn.update(counts)
            in_cases.update(counts.keys())
        for row in h["reviewed_rows"]:
            names = _labels_of(row["payload"])
            for o in (row["payload"] or {}).get("objects") or []:
                label = names.get(o.get("label_id"), "Unlabelled")
                if o.get("review_status") == "accepted":
                    accepted[label] += 1
                elif o.get("review_status") == "rejected":
                    rejected[label] += 1
                    reasons[label][o.get("reject_reason") or "untagged"] += 1
    out = []
    for label in sorted(set(drawn) | set(accepted) | set(rejected)):
        judged = accepted[label] + rejected[label]
        out.append(
            {
                "label": label,
                "objects": drawn[label],
                "cases": in_cases[label],
                "reviewed": judged,
                "rejected": rejected[label],
                "rejection_rate": round(rejected[label] / judged, 3) if judged else None,
                "reasons": [{"reason": r, "count": n} for r, n in reasons[label].most_common()],
            }
        )
    out.sort(key=lambda r: (-r["objects"], r["label"]))
    return out


def people_table(histories: dict[str, dict], legs: list[dict], effort: list[dict], card_types: dict[str, str], names: dict[str, str]) -> list[dict]:
    """What each person did in the study, on both sides: cases annotated,
    submissions, how many passed review first time, times sent back,
    objects drawn, hands-on time; reviews made and their outcome; open
    work right now. Figures about the work, not a ranking."""
    p: dict[str, dict] = defaultdict(
        lambda: {
            "annotated_cases": set(),
            "submissions": 0,
            "first_pass": 0,
            "judged_cases": 0,
            "sent_back": 0,
            "objects": 0,
            "annotate_ms": [],
            "reviews": 0,
            "approved": 0,
            "rejected": 0,
            "review_ms": [],
            "review_work_ms": [],
            "open": 0,
        }
    )
    for case_id, h in histories.items():
        by_author: dict[str, list[dict]] = defaultdict(list)
        for s in h["submissions"]:
            by_author[s["annotator_id"]].append(s)
        for author, subs in by_author.items():
            me = p[author]
            me["annotated_cases"].add(case_id)
            me["submissions"] += len(subs)
            me["objects"] += sum(objects_by_label(subs[-1]["payload"]).values())
            first = subs[0]["created_at"]
            after = [d for d in h["decisions"] if d["created_at"] >= first]
            if after:
                me["judged_cases"] += 1
                me["first_pass"] += 1 if after[0]["decision"] == "approve" else 0
            me["sent_back"] += sum(1 for d in h["decisions"] if d["decision"] == "reject" and d["created_at"] >= first)
        for d in h["decisions"]:
            me = p[d["reviewer_id"]]
            me["reviews"] += 1
            me["approved" if d["decision"] == "approve" else "rejected"] += 1
    for e in effort:
        kind = card_types.get(e["job_id"])
        if kind not in ("annotation", "review") or not e["active_ms"]:
            continue
        for uid in e["user_ids"]:
            p[uid]["annotate_ms" if kind == "annotation" else "review_ms"].append(e["active_ms"])
    for leg in legs:
        if leg["card_type"] == "review" and leg.get("actor_id") and leg.get("work_ms") is not None:
            p[leg["actor_id"]]["review_work_ms"].append(leg["work_ms"])
        if leg.get("terminal_at") is None and leg.get("assignee_id"):
            p[leg["assignee_id"]]["open"] += 1

    out = []
    for uid, me in p.items():
        annotated = len(me["annotated_cases"])
        out.append(
            {
                "user_id": uid,
                "username": names.get(uid, uid),
                "annotated_cases": annotated,
                "submissions": me["submissions"],
                "first_pass_rate": round(me["first_pass"] / me["judged_cases"], 3) if me["judged_cases"] else None,
                "sent_back": me["sent_back"],
                "objects": me["objects"],
                "annotate_total_ms": sum(me["annotate_ms"]),
                "annotate_per_case_ms": _med(me["annotate_ms"]),
                "annotate_per_object_ms": int(sum(me["annotate_ms"]) / me["objects"]) if me["objects"] and me["annotate_ms"] else None,
                "reviews": me["reviews"],
                "approved": me["approved"],
                "rejected": me["rejected"],
                "review_total_ms": sum(me["review_ms"]),
                "review_per_case_ms": _med(me["review_ms"]),
                "review_turnaround_ms": _med(me["review_work_ms"]),
                "open_now": me["open"],
            }
        )
    out.sort(key=lambda r: r["username"].lower())
    return out


def card_metrics(cards: list[dict], legs: list[dict], effort: list[dict], histories: dict[str, dict]) -> dict[str, dict]:
    """Per Annotation/Review card: cases that entered, finished, still
    open; median wait and work; median hands-on per case; and the
    outcome -- first-time review pass for an annotation card, approved
    vs. sent back for a review card."""
    decisions_by_case = {cid: h["decisions"] for cid, h in histories.items()}
    by_card: dict[str, list[dict]] = defaultdict(list)
    for leg in legs:
        by_card[leg["card_id"]].append(leg)
    hands_on: dict[str, list[int]] = defaultdict(list)
    for e in effort:
        if e["active_ms"]:
            hands_on[e["job_id"]].append(e["active_ms"])
    out = {}
    for card in cards:
        if card["type"] not in ("annotation", "review"):
            continue
        rows = by_card.get(card["id"], [])
        finished = [leg for leg in rows if leg["terminal_at"] is not None]
        m = {
            "entered": len(rows),
            "finished": len(finished),
            "open": len(rows) - len(finished),
            "wait_median_ms": _med([leg["queue_ms"] for leg in rows]),
            "work_median_ms": _med([leg["work_ms"] for leg in rows]),
            "hands_on_median_ms": _med(hands_on.get(card["id"], [])),
            "hands_on_total_ms": sum(hands_on.get(card["id"], [])),
        }
        if card["type"] == "annotation":
            # the same case histories as the page's headline, limited to the
            # decisions made after the case entered this card
            firsts, sent_back = [], 0
            for leg in rows:
                after = [d for d in decisions_by_case.get(leg["case_id"], []) if d["created_at"] >= leg["queue_start"]]
                if after:
                    firsts.append(after[0]["decision"] == "approve")
                sent_back += sum(1 for d in after if d["decision"] == "reject")
            m["first_pass_rate"] = round(sum(firsts) / len(firsts), 3) if firsts else None
            m["sent_back"] = sent_back
        else:
            approved = rejected = 0
            for leg in finished:
                first = next((d for d in decisions_by_case.get(leg["case_id"], []) if d["created_at"] >= leg["queue_start"]), None)
                if first is not None:
                    approved += first["decision"] == "approve"
                    rejected += first["decision"] == "reject"
            m["approved"], m["rejected"] = approved, rejected
        out[card["id"]] = m
    return out


def weekly_throughput(histories: dict[str, dict]) -> list[dict]:
    """Submissions, approvals and rejections per ISO week (Monday)."""
    weeks: dict = defaultdict(lambda: {"submitted": 0, "approved": 0, "rejected": 0})

    def monday(at: datetime) -> str:
        return (at - timedelta(days=at.weekday())).date().isoformat()

    for h in histories.values():
        for s in h["submissions"]:
            weeks[monday(s["created_at"])]["submitted"] += 1
        for d in h["decisions"]:
            weeks[monday(d["created_at"])]["approved" if d["decision"] == "approve" else "rejected"] += 1
    return [{"week": w, **v} for w, v in sorted(weeks.items())]


def headline(cases: list[dict], effort: list[dict], card_types: dict[str, str]) -> dict:
    states = Counter(r["state"] for r in cases)
    approved = [r for r in cases if r["state"] == "approved"]
    judged = [r for r in cases if r["first_pass"] is not None]
    return {
        "cases": len(cases),
        "states": {s: states.get(s, 0) for s in ("approved", "awaiting_review", "in_progress", "sent_back", "not_started")},
        "lead_time_median_ms": _med([r["lead_time_ms"] for r in approved]),
        "first_pass_rate": round(sum(1 for r in judged if r["first_pass"]) / len(judged), 3) if judged else None,
        "rounds_median": median([r["rounds"] for r in approved]) if approved else None,
        "objects": sum(r["objects"] for r in cases),
        "hands_on_total_ms": sum(e["active_ms"] for e in effort if card_types.get(e["job_id"]) in ("annotation", "review")),
        "annotate_per_case_median_ms": _med([r["annotate_ms"] for r in cases if r["annotate_ms"]]),
        "review_per_case_median_ms": _med([r["review_ms"] for r in cases if r["review_ms"]]),
    }
