"""Pure aggregation behind a study's analytics page: what happened to
every case of one study on its way through the study's workflow -- which
steps it went through, how many rounds, what was drawn and changed, who
did it and how long it took. No database and no clock: api.py loads plain
rows and passes them in, so tests/test_study_analytics.py can pin every
figure down.

A workflow can have any number of job steps: annotation only, one
review, a second (senior) review after the first, several annotation
steps... So nothing here assumes "one annotation, then one review":

- Every *submission* (an annotator sending the case for review) and
  every *decision* (a review's approve/reject) is attributed to a job
  card: the card of that kind the case most recently entered before it
  happened, preferring the one assigned to the person who did it.
- What comes *next* after a step is read from the board: plain edges and
  the Review card's approved/rejected branches (its materialized child
  cards), passing through dataset/filter/split cards until the next job
  cards. A case is finished when nothing is left after its last step.

Two review flows write the same tables differently, and both count:
the viewer's per-object review saves the reviewer's own version and puts
the decision on that row; the admin-ui's whole-annotation review decides
on the annotator's row itself. A submission is therefore a submitted /
approved / rejected row that its own reviewer did not write.

Inputs (all plain dicts):
  annotations: {id, case_id, annotator_id, status, created_at, payload}
  reviews:     {annotation_id, reviewer_id, decision ("approve"|"reject"), comment, created_at}
  cards:       {id, type, title, assignee_id, materialized_source_card_id, materialized_source_handle}
  edges:       {source_card_id, source_handle, target_card_id}
  stage:       {card_id, case_id, occurred_at} -- when a case entered a job card
  legs:        pipeline_health legs (card_id, card_type, case_id, queue_ms, work_ms, ...)
  effort:      usage.stats.case_effort entries (job_id, case_id, user_ids, active_ms, ...)
"""
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import median

SUBMITTED_STATUSES = ("submitted", "approved", "rejected")
JOB_TYPES = ("annotation", "review")
# Cases sent back at least this often are listed as problem cases.
PROBLEM_SENT_BACK = 2

STATES = ("sent_back", "awaiting_review", "awaiting_next", "in_progress", "not_started", "done")


def _ms(delta: timedelta) -> int:
    return int(delta.total_seconds() * 1000)


def _med(values: list) -> int | None:
    values = [v for v in values if v is not None]
    return int(median(values)) if values else None


def _status(value) -> str:
    return getattr(value, "value", value)


# ---------------------------------------------------------------- the board


class Board:
    """The study's workflow as a graph of cards, for "what comes after
    this step?" questions."""

    def __init__(self, cards: list[dict], edges: list[dict]):
        self.cards = {c["id"]: c for c in cards}
        self.out: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
        for e in edges:
            self.out[e["source_card_id"]].append((e["target_card_id"], e.get("source_handle")))
        for c in cards:
            if c.get("materialized_source_card_id"):
                self.out[c["materialized_source_card_id"]].append((c["id"], c.get("materialized_source_handle")))

    def type_of(self, card_id: str | None) -> str | None:
        card = self.cards.get(card_id) if card_id else None
        return card["type"] if card else None

    def next_jobs(self, card_id: str, branch: str | None = None) -> set[str]:
        """The job cards a case reaches next from `card_id`, passing
        through non-job cards. From a Review card, `branch` "approved"
        follows its approved output (and plain outputs), "rejected" its
        rejected output."""
        allowed = {"approved": {"approved", "output", None}, "rejected": {"rejected"}}.get(branch or "")
        start = [t for t, handle in self.out.get(card_id, []) if allowed is None or handle in allowed]
        seen: set[str] = set()
        found: set[str] = set()
        queue = list(start)
        while queue:
            cid = queue.pop()
            if cid in seen or cid == card_id:
                continue
            seen.add(cid)
            if self.type_of(cid) in JOB_TYPES:
                found.add(cid)
                continue
            queue.extend(t for t, _ in self.out.get(cid, []))
        return found


# ---------------------------------------------------------------- per-case history


def _empty_history() -> dict:
    return {"events": [], "drafts": [], "reviewed_rows": [], "submissions": [], "decisions": []}


def case_histories(annotations: list[dict], reviews: list[dict], stage: list[dict], board: Board) -> dict[str, dict]:
    """Per case, in time order: every submission and decision as an event
    {t, kind: submitted|approved|rejected, card_id, by, row, comment},
    attributed to a job card; plus the annotator's drafts and the rows a
    reviewer decided on (their payload has the per-object verdicts)."""
    reviewers_of: dict = defaultdict(set)
    decisions_by_row: dict = defaultdict(list)
    for r in reviews:
        reviewers_of[r["annotation_id"]].add(r["reviewer_id"])
        decisions_by_row[r["annotation_id"]].append(r)
    entries: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
    for s in stage:
        entries[s["case_id"]].append((s["occurred_at"], s["card_id"]))
    for rows in entries.values():
        rows.sort()

    def attribute(case_id: str, kind: str, at: datetime, author: str) -> str | None:
        options = [(t, cid) for t, cid in entries.get(case_id, []) if board.type_of(cid) == kind]
        if not options:
            return None
        before = [(t, cid) for t, cid in options if t <= at] or options[:1]
        mine = [(t, cid) for t, cid in before if (board.cards[cid].get("assignee_id") or None) == author]
        return (mine or before)[-1][1]

    cases: dict[str, dict] = defaultdict(_empty_history)
    for a in sorted(annotations, key=lambda a: a["created_at"]):
        h = cases[a["case_id"]]
        own_review = a["annotator_id"] in reviewers_of.get(a["id"], set())
        status = _status(a["status"])
        if status in SUBMITTED_STATUSES and not own_review:
            h["submissions"].append(a)
            h["events"].append({"t": a["created_at"], "kind": "submitted", "card_id": attribute(a["case_id"], "annotation", a["created_at"], a["annotator_id"]), "by": a["annotator_id"], "row": a, "comment": None})
        elif status == "draft" and not own_review:
            h["drafts"].append(a)
        for d in decisions_by_row.get(a["id"], []):
            kind = "approved" if d["decision"] == "approve" else "rejected"
            event = {"t": d["created_at"], "kind": kind, "card_id": attribute(a["case_id"], "review", d["created_at"], d["reviewer_id"]), "by": d["reviewer_id"], "row": a, "comment": d.get("comment")}
            h["events"].append(event)
            h["decisions"].append(event)
        if a["id"] in decisions_by_row:
            h["reviewed_rows"].append(a)
    for h in cases.values():
        h["events"].sort(key=lambda e: e["t"])
        h["decisions"].sort(key=lambda e: e["t"])
        # a reviewer's version saved mid-review (no decision on it yet) is
        # review work, not an annotator's draft
        reviewers = {d["by"] for d in h["decisions"]}
        h["drafts"] = [a for a in h["drafts"] if a["annotator_id"] not in reviewers]
    return dict(cases)


def case_state(h: dict, board: Board, entered_cards: set[str], card_entries: Counter) -> tuple[str, str | None]:
    """(state, the job card the case is waiting at) from its last event
    and what the board says comes next. done = nothing left after it."""
    events = h["events"]
    last = events[-1] if events else None
    if last is None:
        waiting = next((c for c in sorted(entered_cards) if board.type_of(c) == "annotation"), None)
        return ("in_progress" if h["drafts"] else "not_started"), waiting
    if last["kind"] == "rejected":
        back = board.next_jobs(last["card_id"], "rejected") if last["card_id"] else set()
        target = next(iter(sorted(c for c in back if c in entered_cards) or sorted(back)), None)
        target = target or next((e["card_id"] for e in reversed(events) if e["kind"] == "submitted" and e["card_id"]), None)
        reworked = any(d["created_at"] > last["t"] for d in h["drafts"])
        return ("in_progress" if reworked else "sent_back"), target
    if last["card_id"] is None:
        # annotated outside the board: if the study reviews at all, it waits for that
        has_review = any(board.type_of(c) == "review" for c in board.cards)
        return ("awaiting_review" if last["kind"] == "submitted" and has_review else "done"), None
    nxt = board.next_jobs(last["card_id"], "approved" if last["kind"] == "approved" else None)
    # Cases a split/filter sent down another branch never enter those
    # cards: only count a next step the case entered -- or one that
    # nothing has entered yet (not run yet, so it can't be told apart).
    pending = sorted(c for c in nxt if c in entered_cards) or sorted(c for c in nxt if not card_entries.get(c))
    if not pending:
        return "done", None
    review = next((c for c in pending if board.type_of(c) == "review"), None)
    if review:
        return "awaiting_review", review
    return "awaiting_next", pending[0]


# ---------------------------------------------------------------- payload helpers


def _labels_of(payload: dict | None) -> dict:
    return {lab.get("id"): lab.get("name") or f"Label {lab.get('id')}" for lab in (payload or {}).get("labels") or []}


def objects_by_label(payload: dict | None) -> Counter:
    names = _labels_of(payload)
    return Counter(names.get(o.get("label_id"), "Unlabelled") for o in (payload or {}).get("objects") or [])


def _final_row(h: dict) -> dict | None:
    """The case's latest annotation content: its newest submission, or a
    reviewer's version decided on after it."""
    rows = h["submissions"] + h["reviewed_rows"]
    return max(rows, key=lambda a: a["created_at"]) if rows else (h["drafts"][-1] if h["drafts"] else None)


def _rejected_objects(h: dict) -> list[dict]:
    out = []
    for n, row in enumerate(sorted(h["reviewed_rows"], key=lambda a: a["created_at"]), start=1):
        names = _labels_of(row["payload"])
        for o in (row["payload"] or {}).get("objects") or []:
            if o.get("review_status") == "rejected":
                out.append({"review": n, "label": names.get(o.get("label_id"), "Unlabelled"), "instance": o.get("instance_number"), "reason": o.get("reject_reason"), "comment": o.get("comment")})
    return out


# ---------------------------------------------------------------- tables


def cases_table(histories: dict[str, dict], stage: list[dict], board: Board, effort: list[dict], titles: dict[str, str], slices: dict[str, int], names: dict[str, str]) -> list[dict]:
    """One row per case that entered the workflow or was annotated: where
    it stands, the steps it went through, rounds and rework, lead time,
    hands-on time on each side, who worked on it, what was drawn at first
    and at the end, and what reviewers rejected."""
    entered: dict[str, dict[str, datetime]] = defaultdict(dict)
    for s in stage:
        prev = entered[s["case_id"]].get(s["card_id"])
        entered[s["case_id"]][s["card_id"]] = min(prev, s["occurred_at"]) if prev else s["occurred_at"]
    card_entries = Counter(s["card_id"] for s in stage)
    hands_on: dict[tuple[str, str], int] = defaultdict(int)
    for e in effort:
        kind = board.type_of(e["job_id"])
        if kind in JOB_TYPES:
            hands_on[(e["case_id"], kind)] += e["active_ms"]

    rows = []
    for case_id in sorted(set(histories) | set(entered)):
        h = histories.get(case_id) or _empty_history()
        state, waiting_at = case_state(h, board, set(entered.get(case_id, {})), card_entries)
        own_rows = sorted(h["drafts"] + h["submissions"], key=lambda a: a["created_at"])
        firsts = [t for cid, t in entered.get(case_id, {}).items() if board.type_of(cid) == "annotation"]
        start = min(firsts) if firsts else (own_rows[0]["created_at"] if own_rows else None)
        done_at = h["events"][-1]["t"] if state == "done" and h["events"] else None
        first_sub = h["submissions"][0] if h["submissions"] else None
        final = _final_row(h)
        final_labels = objects_by_label(final["payload"]) if final else Counter()
        rows.append(
            {
                "case_id": case_id,
                "case_title": titles.get(case_id),
                "state": state,
                "waiting_at": waiting_at,
                "waiting_at_title": board.cards[waiting_at]["title"] if waiting_at in board.cards else None,
                "path": [
                    {"card_id": e["card_id"], "step": board.cards[e["card_id"]]["title"] if e["card_id"] in board.cards else None, "kind": e["kind"], "at": e["t"], "by": names.get(e["by"], e["by"])}
                    for e in h["events"]
                ],
                "rounds": len(h["submissions"]),
                "reviews": len(h["decisions"]),
                "sent_back": sum(1 for d in h["decisions"] if d["kind"] == "rejected"),
                # no review ever rejected it -- across every review step
                "first_pass": (not any(d["kind"] == "rejected" for d in h["decisions"])) if h["decisions"] else None,
                "entered_at": start,
                "done_at": done_at,
                "lead_time_ms": _ms(done_at - start) if done_at and start and done_at >= start else None,
                "annotate_ms": hands_on.get((case_id, "annotation"), 0),
                "review_ms": hands_on.get((case_id, "review"), 0),
                "annotators": sorted({names.get(a["annotator_id"], a["annotator_id"]) for a in h["submissions"] + h["drafts"]}),
                "reviewers": sorted({names.get(d["by"], d["by"]) for d in h["decisions"]}),
                "slices": slices.get(case_id),
                "objects_first": sum(objects_by_label(first_sub["payload"]).values()) if first_sub else None,
                "objects": sum(final_labels.values()),
                "labels": dict(final_labels),
                "rejected_objects": _rejected_objects(h),
                "review_comments": [{"by": names.get(d["by"], d["by"]), "at": d["t"], "text": d["comment"]} for d in h["decisions"] if d["kind"] == "rejected" and d.get("comment")],
            }
        )
    order = {s: i for i, s in enumerate(STATES)}
    rows.sort(key=lambda r: (order[r["state"]], -r["sent_back"], r["case_title"] or r["case_id"]))
    return rows


def label_table(histories: dict[str, dict]) -> list[dict]:
    """Per label (by name, across the study): objects in each case's
    first submission and in its final version, cases it appears in, and
    -- from the reviewers' per-object verdicts -- how often objects of
    that label were rejected and why."""
    first: Counter = Counter()
    final: Counter = Counter()
    in_cases: Counter = Counter()
    accepted: Counter = Counter()
    rejected: Counter = Counter()
    reasons: dict[str, Counter] = defaultdict(Counter)
    for h in histories.values():
        if h["submissions"]:
            first.update(objects_by_label(h["submissions"][0]["payload"]))
        row = _final_row(h)
        if row and (h["submissions"] or h["reviewed_rows"]):
            counts = objects_by_label(row["payload"])
            final.update(counts)
            in_cases.update(counts.keys())
        for reviewed in h["reviewed_rows"]:
            names = _labels_of(reviewed["payload"])
            for o in (reviewed["payload"] or {}).get("objects") or []:
                label = names.get(o.get("label_id"), "Unlabelled")
                if o.get("review_status") == "accepted":
                    accepted[label] += 1
                elif o.get("review_status") == "rejected":
                    rejected[label] += 1
                    reasons[label][o.get("reject_reason") or "untagged"] += 1
    out = []
    for label in sorted(set(first) | set(final) | set(accepted) | set(rejected)):
        judged = accepted[label] + rejected[label]
        out.append(
            {
                "label": label,
                "objects_first": first[label],
                "objects": final[label],
                "cases": in_cases[label],
                "reviewed": judged,
                "rejected": rejected[label],
                "rejection_rate": round(rejected[label] / judged, 3) if judged else None,
                "reasons": [{"reason": r, "count": n} for r, n in reasons[label].most_common()],
            }
        )
    out.sort(key=lambda r: (-r["objects"], r["label"]))
    return out


def people_table(histories: dict[str, dict], legs: list[dict], effort: list[dict], board: Board, names: dict[str, str]) -> list[dict]:
    """What each person did in the study, on both sides: cases annotated,
    submissions, how many got through every review without a rejection,
    times sent back, objects in the final versions of their cases,
    hands-on time; reviews made and their outcome; open work now.
    Figures about the work, not a ranking."""
    p: dict[str, dict] = defaultdict(
        lambda: {"cases": set(), "submissions": 0, "clean": 0, "judged": 0, "sent_back": 0, "objects": 0, "annotate_ms": [], "reviews": 0, "approved": 0, "rejected": 0, "review_ms": [], "review_work_ms": [], "open": 0}
    )
    for h in histories.values():
        authors: dict[str, list[dict]] = defaultdict(list)
        for s in h["submissions"]:
            authors[s["annotator_id"]].append(s)
        for author, subs in authors.items():
            me = p[author]
            me["cases"].add(subs[0]["case_id"])
            me["submissions"] += len(subs)
            final = _final_row(h)
            me["objects"] += sum(objects_by_label(final["payload"]).values()) if final else 0
            after = [d for d in h["decisions"] if d["t"] >= subs[0]["created_at"]]
            if after:
                me["judged"] += 1
                me["clean"] += not any(d["kind"] == "rejected" for d in after)
            me["sent_back"] += sum(1 for d in after if d["kind"] == "rejected")
        for d in h["decisions"]:
            me = p[d["by"]]
            me["reviews"] += 1
            me["approved" if d["kind"] == "approved" else "rejected"] += 1
    for e in effort:
        kind = board.type_of(e["job_id"])
        if kind not in JOB_TYPES or not e["active_ms"]:
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
        out.append(
            {
                "user_id": uid,
                "username": names.get(uid, uid),
                "annotated_cases": len(me["cases"]),
                "submissions": me["submissions"],
                "first_pass_rate": round(me["clean"] / me["judged"], 3) if me["judged"] else None,
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


def card_metrics(board: Board, stage: list[dict], legs: list[dict], effort: list[dict], histories: dict[str, dict], cases: list[dict]) -> dict[str, dict]:
    """Per job card (each step of the workflow): cases that entered, the
    ones it has finished with, the ones waiting there now; its rounds and
    outcome -- for an annotation step how often its work came back and
    how often it got through its next review first time, for a review
    step what it approved and sent back; median wait and work; hands-on
    per case."""
    entered: dict[str, set[str]] = defaultdict(set)
    for s in stage:
        entered[s["card_id"]].add(s["case_id"])
    here = Counter(row["waiting_at"] for row in cases if row["waiting_at"] and row["state"] != "done")
    legs_by_card: dict[str, list[dict]] = defaultdict(list)
    for leg in legs:
        legs_by_card[leg["card_id"]].append(leg)
    hands_on: dict[str, list[int]] = defaultdict(list)
    for e in effort:
        if e["active_ms"]:
            hands_on[e["job_id"]].append(e["active_ms"])

    out = {}
    for cid, card in board.cards.items():
        if card["type"] not in JOB_TYPES:
            continue
        m = {
            "entered": len(entered[cid]),
            "open": here.get(cid, 0),
            "wait_median_ms": _med([leg["queue_ms"] for leg in legs_by_card[cid]]),
            "work_median_ms": _med([leg["work_ms"] for leg in legs_by_card[cid]]),
            "hands_on_median_ms": _med(hands_on.get(cid, [])),
            "hands_on_total_ms": sum(hands_on.get(cid, [])),
        }
        if card["type"] == "annotation":
            submitted_cases, submissions, sent_back, firsts = set(), 0, 0, []
            for case_id, h in histories.items():
                mine = [i for i, e in enumerate(h["events"]) if e["kind"] == "submitted" and e["card_id"] == cid]
                if not mine:
                    continue
                submitted_cases.add(case_id)
                submissions += len(mine)
                # the decision right after each of this step's submissions
                verdicts = [next((e for e in h["events"][i + 1 :] if e["kind"] != "submitted"), None) for i in mine]
                sent_back += sum(1 for v in verdicts if v and v["kind"] == "rejected")
                if verdicts[0] is not None:
                    firsts.append(verdicts[0]["kind"] == "approved")
            m.update({"finished": len(submitted_cases), "submissions": submissions, "sent_back": sent_back, "first_pass_rate": round(sum(firsts) / len(firsts), 3) if firsts else None})
        else:
            decided_cases, approved, rejected, firsts = set(), 0, 0, []
            for case_id, h in histories.items():
                mine = [e for e in h["decisions"] if e["card_id"] == cid]
                if not mine:
                    continue
                decided_cases.add(case_id)
                approved += sum(1 for e in mine if e["kind"] == "approved")
                rejected += sum(1 for e in mine if e["kind"] == "rejected")
                firsts.append(mine[0]["kind"] == "approved")
            m.update({"finished": len(decided_cases), "approved": approved, "rejected": rejected, "first_pass_rate": round(sum(firsts) / len(firsts), 3) if firsts else None})
        out[cid] = m
    return out


def weekly_throughput(histories: dict[str, dict]) -> list[dict]:
    """Submissions, approvals and rejections per ISO week (Monday)."""
    weeks: dict = defaultdict(lambda: {"submitted": 0, "approved": 0, "rejected": 0})
    for h in histories.values():
        for e in h["events"]:
            weeks[(e["t"] - timedelta(days=e["t"].weekday())).date().isoformat()][e["kind"]] += 1
    return [{"week": w, **v} for w, v in sorted(weeks.items())]


def headline(cases: list[dict], effort: list[dict], board: Board) -> dict:
    states = Counter(r["state"] for r in cases)
    done = [r for r in cases if r["state"] == "done"]
    judged = [r for r in cases if r["first_pass"] is not None]
    return {
        "cases": len(cases),
        "states": {s: states.get(s, 0) for s in STATES},
        "lead_time_median_ms": _med([r["lead_time_ms"] for r in done]),
        "first_pass_rate": round(sum(1 for r in judged if r["first_pass"]) / len(judged), 3) if judged else None,
        "rounds_median": median([r["rounds"] for r in done]) if done else None,
        "problem_cases": sum(1 for r in cases if r["sent_back"] >= PROBLEM_SENT_BACK),
        "objects": sum(r["objects"] for r in cases),
        "slices": sum(r["slices"] or 0 for r in cases),
        "hands_on_total_ms": sum(e["active_ms"] for e in effort if board.type_of(e["job_id"]) in JOB_TYPES),
        "annotate_per_case_median_ms": _med([r["annotate_ms"] for r in cases if r["annotate_ms"]]),
        "review_per_case_median_ms": _med([r["review_ms"] for r in cases if r["review_ms"]]),
        "steps": sum(1 for c in board.cards.values() if c["type"] in JOB_TYPES),
    }
