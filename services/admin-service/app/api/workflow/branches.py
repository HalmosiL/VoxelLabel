"""Which branch of the annotations a workflow card works on.

A Duplicate card sends the same cases down several lanes (its "copy_0",
"copy_1", ... Dataset children); each lane is annotated apart, on its own
branch of every image's annotation (annotation-service's
Annotation.branch). A card's branch is read off the board: walk up its
inputs, and every Duplicate copy passed on the way adds its lane key
("d:<card id hex>:copy_1"; nested Duplicates joined with "/"). No
Duplicate upstream: the main chain, None -- every board without one works
exactly as before.

A job fed from two copies at once would mix two annotators' work on one
image: `lanes_reaching` lets the Run refuse that. The copies end at a
Compare card: its "agree"/"disagree" Datasets are back on the main chain,
for an adjudicator's final segmentation.
"""
from shared_models.models import WorkflowCard, WorkflowCardType, WorkflowEdge
from sqlalchemy.orm import Session

MIN_COPIES = 2
MAX_COPIES = 4


def lane_key(duplicate: WorkflowCard, handle: str) -> str:
    """One copy's own key -- short (a branch is at most 128 characters,
    so three Duplicates can nest) and plain (see annotation-service's
    _BRANCH_RE)."""
    return f"d:{duplicate.id.hex}:{handle}"


def duplicate_copies(config: dict) -> int:
    """How many copies a Duplicate makes (validated on save, see
    routes._validate_duplicate)."""
    copies = config.get("copies", MIN_COPIES)
    return copies if isinstance(copies, int) and not isinstance(copies, bool) and MIN_COPIES <= copies <= MAX_COPIES else MIN_COPIES


def copy_title(config: dict, index: int) -> str:
    """A copy's Dataset title: the name given for it, else "Copy A", "Copy B", ..."""
    names = config.get("names")
    if isinstance(names, list) and index < len(names) and isinstance(names[index], str) and names[index].strip():
        return names[index].strip()[:120]
    return f"Copy {chr(ord('A') + index)}"


def _join(above: str | None, key: str) -> str:
    return key if above is None else f"{above}/{key}"


def _branches(db: Session, card: WorkflowCard, visiting: frozenset) -> set:
    """Every branch reaching `card` -- empty when all its inputs lead back
    into a loop already being walked (a Review's "(rejected)" fed back
    into its Annotation: that input adds nothing of its own)."""
    if card.id in visiting:
        return set()
    visiting = visiting | {card.id}
    if card.materialized_source_card_id is not None:
        # a made Dataset stands for its maker's output: a Split part,
        # "(annotated)", "(approved)" ... -- or one of a Duplicate's copies
        maker = db.get(WorkflowCard, card.materialized_source_card_id)
        if maker is None or maker.type == WorkflowCardType.COMPARE:
            # the copies end at a Compare: what it hands on ("agree",
            # "disagree") is for the agreed, final work -- the main chain
            return {None}
        above = _branches(db, maker, visiting) or {None}
        if maker.type == WorkflowCardType.DUPLICATE:
            return {_join(b, lane_key(maker, card.materialized_source_handle or "copy_0")) for b in above}
        return above
    found: set = set()
    edges = db.query(WorkflowEdge).filter(WorkflowEdge.target_card_id == card.id, WorkflowEdge.target_handle != "surface_config").all()
    for edge in edges:
        source = db.get(WorkflowCard, edge.source_card_id)
        if source is not None:
            found |= _branches(db, source, visiting)
    if not edges:
        found.add(None)
    return found


def lanes_reaching(db: Session, card: WorkflowCard) -> set:
    """Every branch `card`'s inputs come from: {None} off any Duplicate,
    one lane key inside a copy, more than one when copies were merged."""
    return _branches(db, card, frozenset()) or {None}


def card_branch(db: Session, card: WorkflowCard) -> str | None:
    """The branch `card` works on. A card fed from several copies has none
    it could honestly name -- its Run is refused (see engine) -- so it
    reads as the main chain rather than failing a board load."""
    lanes = lanes_reaching(db, card)
    return next(iter(lanes)) if len(lanes) == 1 else None
