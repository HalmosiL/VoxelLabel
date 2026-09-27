"""The Compare card's Run: its inputs' work on the same images, side by side.

Each input is a card on its own branch of the annotations (typically one
Duplicate copy's Annotation job, see branches.py). For every case at least
two inputs share, each image (series) is compared between every pair of
inputs that handed it in: the annotator's own latest hand-in on that
branch (submitted, or since decided) -- not a draft being reworked, not a
reviewer's edit of it -- through app/quality/compare.py.

The result is a plain dict the engine stores on the card
(`config.results`), with the cases that agree and those that don't.
"""
import gzip
from datetime import datetime
from itertools import combinations

import numpy as np
from fastapi import HTTPException
from shared_models.models import Annotation, AnnotationStatus, AnnotationType, Case, ImagingStudy, Series, WorkflowCard, WorkflowCardType, WorkflowEdge
from sqlalchemy.orm import Session

from app.quality.compare import compare_pair, object_labels
from app.storage import download_object

from .branches import card_branch
from .graph import _resolve_output

DEFAULT_AGREE_DICE = 0.7


def agree_dice(config: dict) -> float:
    value = config.get("agree_dice", DEFAULT_AGREE_DICE)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1 else DEFAULT_AGREE_DICE


def _inputs(db: Session, card: WorkflowCard) -> list[dict]:
    """Every input: its card, title, branch, cases and whose job it is."""
    edges = db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="input").order_by(WorkflowEdge.id).all()
    found = []
    for edge in edges:
        source = db.get(WorkflowCard, edge.source_card_id)
        if source is None:
            continue
        job = db.get(WorkflowCard, source.materialized_source_card_id) if source.materialized_source_card_id else source
        found.append(
            {
                "card": source,
                "card_id": str(source.id),
                "title": source.title,
                "branch": card_branch(db, source),
                "assigned_user_id": (job.config or {}).get("assigned_user_id") if job is not None else None,
                # the job behind it (itself, or the job that made this "(annotated)" card): the viewer opens its branch
                "job_id": str(job.id) if job is not None and job.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW) else None,
                "cases": set(_resolve_output(db, source, set())),
            }
        )
    # edges carry no order of their own: the board's reading order (top to
    # bottom, left to right), then the title -- the same on every Run
    found.sort(key=lambda i: (i["card"].position_y, i["card"].position_x, i["title"], i["card_id"]))
    return found


def _handed_in_versions(db: Session, series_ids: list, branch: str | None) -> dict:
    """Each series' latest version its annotator handed in, on `branch`."""
    atype = db.query(AnnotationType).filter_by(name="segmentation_volume").first()
    if atype is None or not series_ids:
        return {}
    rows = (
        db.query(Annotation)
        .filter(
            Annotation.target_type == "series",
            Annotation.target_id.in_(series_ids),
            Annotation.type_id == atype.id,
            Annotation.branch.is_(None) if branch is None else Annotation.branch == branch,
            Annotation.status != AnnotationStatus.DRAFT,
            Annotation.review_of_id.is_(None),
        )
        .order_by(Annotation.created_at)
        .all()
    )
    return {row.target_id: row for row in rows}  # oldest first: the last one wins


def _mask(version: Annotation) -> np.ndarray | None:
    key = (version.payload or {}).get("mask_volume_key")
    if not isinstance(key, str):
        return None
    return np.frombuffer(gzip.decompress(download_object(key)), dtype=np.uint8)


def compare(db: Session, card: WorkflowCard, now: datetime) -> tuple[dict, list[str], list[str]]:
    """(results, agreeing case ids, disagreeing case ids)."""
    inputs = _inputs(db, card)
    if len(inputs) < 2 or len({i["branch"] for i in inputs}) < len(inputs):
        raise HTTPException(
            status_code=422,
            detail="Compare needs at least two inputs, each on its own branch -- e.g. the Annotation jobs of two copies of a Duplicate",
        )
    threshold = agree_dice(card.config)
    shared = sorted({cid for i in inputs for cid in i["cases"] if sum(cid in j["cases"] for j in inputs) >= 2})
    cases = {str(c.id): c for c in db.query(Case).filter(Case.id.in_(shared), Case.study_id == card.study_id).all()}
    series_by_case: dict[str, list] = {}
    for case_id, series_id in (
        db.query(ImagingStudy.case_id, Series.id).join(Series, Series.imaging_study_id == ImagingStudy.id).filter(ImagingStudy.case_id.in_(list(cases))).all()
    ):
        series_by_case.setdefault(str(case_id), []).append(series_id)
    all_series = [s for ids in series_by_case.values() for s in ids]
    versions = [_handed_in_versions(db, all_series, i["branch"]) for i in inputs]

    images, skipped, agree, disagree = [], [], [], []
    for case_id in shared:
        case = cases.get(case_id)
        if case is None:
            continue
        compared_any, case_ok = False, True
        for series_id in series_by_case.get(case_id, []):
            present = [k for k, i in enumerate(inputs) if case_id in i["cases"] and series_id in versions[k]]
            if len(present) < 2:
                continue
            masks = {k: _mask(versions[k][series_id]) for k in present}
            labels = {k: object_labels(versions[k][series_id].payload) for k in present}
            pairs = []
            for a, b in combinations(present, 2):
                if masks[a] is None or masks[b] is None or masks[a].shape != masks[b].shape:
                    continue
                pairs.append({"a": a, "b": b, **compare_pair(masks[a], labels[a], masks[b], labels[b])})
            del masks
            if not pairs:
                continue
            compared_any = True
            dices = [p["dice"] for p in pairs if p["dice"] is not None]
            min_dice = min(dices) if dices else None
            case_ok = case_ok and (min_dice is None or min_dice >= threshold)
            images.append({"case_id": case_id, "case_title": case.title, "series_id": str(series_id), "pairs": pairs, "min_dice": min_dice})
        if compared_any:
            (agree if case_ok else disagree).append(case_id)
        else:
            missing = [i["title"] for k, i in enumerate(inputs) if case_id in i["cases"] and not any(s in versions[k] for s in series_by_case.get(case_id, []))]
            skipped.append({"case_id": case_id, "case_title": case.title, "reason": f"not handed in yet in {', '.join(missing)}" if missing else "no image to compare"})

    pair_summary = []
    for a, b in combinations(range(len(inputs)), 2):
        mine = [p for image in images for p in image["pairs"] if (p["a"], p["b"]) == (a, b)]
        dices = [p["dice"] for p in mine if p["dice"] is not None]
        pair_summary.append(
            {
                "a": a,
                "b": b,
                "images": len(mine),
                "mean_dice": round(sum(dices) / len(dices), 3) if dices else None,
                "objects": {k: sum(p["objects"][k] for p in mine) for k in ("both", "only_a", "only_b")},
            }
        )
    results = {
        "computed_at": now.isoformat(),
        "agree_dice": threshold,
        "inputs": [{k: i[k] for k in ("card_id", "job_id", "title", "branch", "assigned_user_id")} for i in inputs],
        "pairs": pair_summary,
        "images": images,
        "skipped": skipped,
        "cases_agree": len(agree),
        "cases_disagree": len(disagree),
    }
    return results, agree, disagree
