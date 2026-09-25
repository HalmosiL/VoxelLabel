"""The Clinical Trial module's MCP server -- a real, separate MCP
server (not a mocked stand-in) exposing the tools a small local model
(driven from admin-service's llm_client, over Streamable HTTP) can call
against the module's three chat-capable card types (see
llm_client._ALLOWED_TOOLS_BY_CARD_TYPE for which tools each role is
actually given):
- a Clinical Trial Assistant ("llm") card: seeing what data is
  connected to it, looking at cases one at a time (tags, whether they
  have imaging/documents), reading a document's actual content where
  that's feasible, and creating a new Dataset card -- either from
  everything connected, or from a specific case_ids list the model
  itself chose after inspecting cases individually.
- a Pipeline Builder ("builder") card: seeing the whole board's actual
  graph (list_board_cards' cards *and* edges), and extending it --
  adding a root Dataset, chaining Criterion/Split cards onto an
  existing card's output or another Split/Criterion's own named
  branch, or wiring an arbitrary new edge between two existing cards
  (connect_cards) -- all through the same handle-rule-aware resolution
  (_resolve_edge_source) that keeps it from creating a graph nothing
  can actually read output from.
- an Eligibility Criterion ("criterion") card: judging every case
  connected to its input against its own stored criterion text, and
  materializing the resulting included/excluded split.

Runs as its own service with no host port published -- reachable only
inside the docker-compose network. The trust boundary is admin-service's
own require_study_role check on the one endpoint that ever talks to
this server (llm_chat), not anything enforced here.

Talks to the same Postgres database directly via shared_models, rather
than calling back into admin-service's own REST API -- this repo's
services never share business-logic modules across a network hop, only
the shared_models/shared_auth libraries, so this reimplements the small
amount of "resolve connected cases" / "create a Dataset card" logic that
already exists in admin-service's own workflow.py (see
_llm_connected_case_ids and the old mocked llm_chat's dataset-creation
branch) rather than importing it.
"""
import io
import os
import uuid

import boto3
import pypdf
from botocore.config import Config
from mcp.server.mcpserver import MCPServer
from shared_models.models import (
    Case,
    ClinicalDataItem,
    ImagingStudy,
    Tag,
    WorkflowCard,
    WorkflowCardType,
    WorkflowEdge,
    case_tags,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://ctplatform:ctplatform@localhost:5432/ctplatform"
)
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)

# Real fetches happen from inside this container, on the docker-compose
# network -- the internal hostname, same reasoning as ingestion-service's
# own storage.py (contrast admin-ui-facing services, which sign
# presigned URLs for the *browser* and need the published hostname
# instead).
_OBJECT_STORAGE_ENDPOINT = os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://minio:9000")
_OBJECT_STORAGE_BUCKET = os.environ.get("OBJECT_STORAGE_BUCKET", "ct-pixel-data")
_s3 = boto3.client(
    "s3",
    endpoint_url=_OBJECT_STORAGE_ENDPOINT,
    aws_access_key_id=os.environ.get("OBJECT_STORAGE_ACCESS_KEY", "minioadmin"),
    aws_secret_access_key=os.environ.get("OBJECT_STORAGE_SECRET_KEY", "minioadmin"),
    config=Config(connect_timeout=3, retries={"total_max_attempts": 2, "mode": "standard"}),  # fail fast when storage is down
)

# Only these extensions are ever attempted as read-as-text -- a scanned
# image, an unrecognized binary format, etc. would decode to garbage or
# fail outright, and a small model can't OCR/parse binary formats
# anyway. Reading a real DICOM's pixel data is out of scope for the same
# reason -- what's useful to the model is *whether* a case has imaging
# at all, not its pixels (see list_cases/get_case_details' has_imaging
# instead).
_READABLE_TEXT_EXTENSIONS = (".txt", ".md", ".csv", ".json", ".xml", ".log")
# PDF is the real clinical-document format this platform's reports come
# in (radiology/pulmonology/oncology findings) -- handled separately
# from the plain-text extensions above since it needs actual text
# extraction (pypdf), not a bare .decode().
_READABLE_PDF_EXTENSION = ".pdf"

# Card types with no real "output" handle of their own (mirrors
# admin-service's _NO_OUTPUT_TYPES) -- what they produce is always
# expressed as named materialized Dataset children instead. Never wire
# an edge directly from one of these when the requested branch hasn't
# been materialized yet -- see _resolve_edge_source.
_NO_REAL_OUTPUT_TYPES = {WorkflowCardType.SPLIT, WorkflowCardType.LLM, WorkflowCardType.CRITERION}
# Card types with no real "input" handle at all (mirrors admin-service's
# _NO_INPUT_TYPES) -- Note/Milestone are pure annotations on the board,
# Builder is scoped to the whole study rather than connected data, and
# the Surface types are a separate, non-data "surface_config" channel
# (out of scope for connect_cards, which only ever wires the ordinary
# "input" data-flow handle).
_NO_REAL_INPUT_TYPES = {
    WorkflowCardType.NOTE,
    WorkflowCardType.MILESTONE,
    WorkflowCardType.BUILDER,
    WorkflowCardType.SURFACE,
    WorkflowCardType.ANNOTATION_SURFACE,
    WorkflowCardType.REVIEW_SURFACE,
}

mcp = MCPServer("Clinical Trial Assistant")


def _dataset_case_ids(db, dataset_card: WorkflowCard) -> list[str]:
    """A Dataset card's own case set -- "manual" mode is a stored list,
    "all_cases" is every case in its study, computed live. Mirrors
    admin-service's _dataset_output_ids exactly (kept in sync by hand,
    same reasoning as this file's own docstring)."""
    if dataset_card.config.get("mode") == "manual":
        return list(dataset_card.config.get("case_ids", []))
    return [str(c.id) for c in db.query(Case).filter_by(study_id=dataset_card.study_id).all()]


def _connected_case_ids(db, card_id: uuid.UUID) -> list[str]:
    """Every case reachable from a card's real "input" edges, unioned
    and deduped -- mirrors admin-service's _llm_connected_case_ids. Only
    Dataset sources are resolved directly here (the common case for what
    feeds a Clinical Trial Assistant card); any other still-un-Run source
    type simply contributes nothing rather than erroring, since this
    server has no Run/staleness machinery of its own to fall back on."""
    incoming = db.query(WorkflowEdge).filter_by(target_card_id=card_id, target_handle="input").all()
    ids: set[str] = set()
    for edge in incoming:
        source = db.get(WorkflowCard, edge.source_card_id)
        if source is None:
            continue
        if source.type == WorkflowCardType.DATASET:
            ids.update(_dataset_case_ids(db, source))
        elif source.output_case_ids:
            ids.update(source.output_case_ids)
    return sorted(ids)


def _resolve_edge_source(db, source: WorkflowCard, source_handle: str):
    """Resolves what a new edge should actually originate from, given a
    caller-supplied (source_card_id, source_handle) pair -- shared by
    every tool that wires a new edge onto an existing card
    (add_criterion, create_split_card, connect_cards).

    Split/LLM/Criterion cards have no directly connectable "output"
    handle of their own (see handleRules.ts on the frontend): what a
    person or model actually chains onward from is always the concrete
    Dataset card materialized for a named branch (Criterion's
    "included"/"excluded", Split's "part_0"/"part_1", ...). So: if
    source_handle names one of source's own materialized children,
    resolve to that child instead of source itself. Otherwise, if
    source itself has no real output at all, refuse rather than
    silently wiring an edge from a card type nothing can ever read
    output from (that's exactly the bug this function was extracted to
    fix once already -- see add_criterion's history).

    Returns the resolved WorkflowCard to use as source_card_id on
    success, or a dict with an "error" key on failure -- check
    `isinstance(result, WorkflowCard)` to tell which."""
    child = (
        db.query(WorkflowCard)
        .filter_by(materialized_source_card_id=source.id, materialized_source_handle=source_handle)
        .first()
    )
    if child is not None:
        return child
    if source.type in _NO_REAL_OUTPUT_TYPES:
        return {
            "error": (
                f"'{source.title}' has no '{source_handle}' branch yet -- it needs to be evaluated/run first "
                "(open its own chat session and ask it to evaluate, for a Criterion; or Run it, for a Split) "
                "before another card can be chained onto that branch."
            )
        }
    return source


@mcp.tool()
def list_connected_data(card_id: str) -> dict:
    """List the data sources connected to this Clinical Trial Assistant
    card right now, and how many cases they contain in total. Call this
    before creating a dataset if you're not sure what's actually
    connected."""
    db = SessionLocal()
    try:
        card = db.get(WorkflowCard, uuid.UUID(card_id))
        if card is None:
            return {"error": f"No card with id {card_id}"}
        incoming = db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="input").all()
        case_ids = _connected_case_ids(db, card.id)
        sample_titles = [
            c.title for c in db.query(Case).filter(Case.id.in_(case_ids)).limit(20).all() if c.title
        ]
        return {
            "connected_source_count": len(incoming),
            "case_count": len(case_ids),
            "sample_case_titles": sample_titles,
        }
    finally:
        db.close()


@mcp.tool()
def list_cases(card_id: str) -> dict:
    """List every case connected to this Clinical Trial Assistant card,
    one entry per case, with just enough about each to decide whether it
    belongs in a filtered dataset: its tags, and whether it has imaging
    (DICOM) and/or documents at all. Call get_case_details on a specific
    case_id for a closer look before deciding."""
    db = SessionLocal()
    try:
        card = db.get(WorkflowCard, uuid.UUID(card_id))
        if card is None:
            return {"error": f"No card with id {card_id}"}
        case_ids = _connected_case_ids(db, card.id)
        cases = db.query(Case).filter(Case.id.in_(case_ids)).all()

        result = []
        for case in cases:
            imaging_count = db.query(ImagingStudy).filter_by(case_id=case.id).count()
            documents = db.query(ClinicalDataItem).filter_by(case_id=case.id).all()
            result.append(
                {
                    "case_id": str(case.id),
                    "title": case.title,
                    "tags": case_tags(case),
                    "has_imaging": imaging_count > 0,
                    "imaging_study_count": imaging_count,
                    "has_documents": len(documents) > 0,
                    "document_count": len(documents),
                }
            )
        return {"cases": result}
    finally:
        db.close()


@mcp.tool()
def get_case_details(case_id: str) -> dict:
    """A closer look at one case: its imaging studies (modality,
    description, how many series) and its documents (title, type,
    date, whether it has a readable file). Use a document_id from here
    with read_document to see a document's actual content."""
    db = SessionLocal()
    try:
        case = db.get(Case, uuid.UUID(case_id))
        if case is None:
            return {"error": f"No case with id {case_id}"}

        imaging_studies = [
            {
                "imaging_study_id": str(s.id),
                "modality": s.modality,
                "description": s.description,
                "series_count": len(s.series),
            }
            for s in db.query(ImagingStudy).filter_by(case_id=case.id).all()
        ]
        documents = [
            {
                "document_id": str(d.id),
                "title": d.title,
                "type": d.type,
                "date": d.date.isoformat() if d.date else None,
                "has_file": d.object_storage_key is not None,
                "tags": [t.label for t in db.query(Tag).filter_by(clinical_data_item_id=d.id).all()],
            }
            for d in db.query(ClinicalDataItem).filter_by(case_id=case.id).all()
        ]
        return {
            "case_id": str(case.id),
            "title": case.title,
            "tags": case_tags(case),
            "imaging_studies": imaging_studies,
            "documents": documents,
        }
    finally:
        db.close()


def _read_document_content(item: ClinicalDataItem) -> dict:
    """The actual "get this document's text" logic, shared by
    read_document (one document) and read_all_documents (every
    connected document at once) -- extracted so a dataset-wide summary
    doesn't have to re-derive it per document. Returns {"content",
    "content_note"} only; the two callers add their own id/title/etc.
    framing around it."""
    if item.object_storage_key is None:
        return {"content": None, "content_note": "This document has no attached file, only metadata."}
    key_lower = item.object_storage_key.lower()
    is_pdf = key_lower.endswith(_READABLE_PDF_EXTENSION)
    if not is_pdf and not key_lower.endswith(_READABLE_TEXT_EXTENSIONS):
        return {
            "content": None,
            "content_note": "The attached file isn't a plain-text or PDF type this tool can read (e.g. a scan or image).",
        }
    try:
        raw = _s3.get_object(Bucket=_OBJECT_STORAGE_BUCKET, Key=item.object_storage_key)["Body"].read()
        if is_pdf:
            reader = pypdf.PdfReader(io.BytesIO(raw))
            content = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
            if not content:
                return {
                    "content": None,
                    "content_note": "This PDF has no extractable text (likely a scanned image, not real text).",
                }
            return {"content": content, "content_note": None}
        return {"content": raw.decode("utf-8", errors="replace"), "content_note": None}
    except Exception as exc:  # noqa: BLE001 -- surfaced to the model as a normal tool result, not a crash
        return {"content": None, "content_note": f"Could not read the file: {exc}"}


@mcp.tool()
def read_document(document_id: str) -> dict:
    """Read one document's metadata, and its actual text content when
    the attached file is readable: a plain-text kind (.txt/.md/.csv/
    .json/.xml/.log) or a PDF (the real format clinical reports on this
    platform come in -- radiology/pulmonology/oncology findings) --
    anything else (a scanned image, ...) comes back with content_note
    explaining why it can't be read this way instead of garbled bytes.
    For a single case you're looking closely at, this is the right
    tool; for a "summarize the whole dataset" request, use
    read_all_documents instead of calling this once per case -- it's
    far more reliable than orchestrating dozens of one-at-a-time calls."""
    db = SessionLocal()
    try:
        item = db.get(ClinicalDataItem, uuid.UUID(document_id))
        if item is None:
            return {"error": f"No document with id {document_id}"}
        base = {
            "document_id": str(item.id),
            "title": item.title,
            "type": item.type,
            "date": item.date.isoformat() if item.date else None,
        }
        return {**base, **_read_document_content(item)}
    finally:
        db.close()


# Keeps one bulk read from blowing past a small model's context window
# on a large dataset -- combined with the system prompt + tool schemas +
# conversation so far, this leaves comfortable headroom under the 8192
# num_ctx llm_client.py requests (see its own comment for why).
_READ_ALL_DOCUMENTS_CHAR_BUDGET = 12000


@mcp.tool()
def read_all_documents(card_id: str) -> dict:
    """Read every readable document (plain-text or PDF) across every
    case connected to this card, in one call -- one case's title paired
    with its document's extracted text, for every case that has one.
    This is the right tool for a "summarize this dataset" / "what
    conditions occur" request: reading real content case by case with
    repeated read_document calls is unreliable for a small model across
    a whole dataset, so this does it in one round instead. Capped at a
    combined ~12000 characters across all documents -- if the dataset is
    larger than that, "truncated" comes back true and "documents_included"
    / "documents_total" tell you how much you're actually seeing, so you
    can say so rather than presenting a partial read as the whole
    picture."""
    db = SessionLocal()
    try:
        card = db.get(WorkflowCard, uuid.UUID(card_id))
        if card is None:
            return {"error": f"No card with id {card_id}"}
        case_ids = _connected_case_ids(db, card.id)
        cases = db.query(Case).filter(Case.id.in_(case_ids)).all()

        readable_pairs = [
            (case, item)
            for case in cases
            for item in db.query(ClinicalDataItem).filter_by(case_id=case.id).all()
            if item.object_storage_key is not None
        ]

        documents = []
        total_chars = 0
        truncated = False
        for case, item in readable_pairs:
            if total_chars >= _READ_ALL_DOCUMENTS_CHAR_BUDGET:
                truncated = True
                break
            read = _read_document_content(item)
            if read["content"] is None:
                continue
            documents.append(
                {
                    "case_id": str(case.id),
                    "case_title": case.title,
                    "document_title": item.title,
                    "content": read["content"],
                }
            )
            total_chars += len(read["content"])

        return {
            "documents": documents,
            "documents_included": len(documents),
            "documents_total": len(readable_pairs),
            "truncated": truncated,
        }
    finally:
        db.close()


@mcp.tool()
def list_board_cards(study_id: str) -> dict:
    """List the whole board's actual graph: every card (id, type, title,
    and -- for a card that materializes named children, e.g. a Criterion
    already evaluated at least once -- the ids of those children keyed
    by handle name), *and* every real edge between them (which card's
    which output handle feeds which card's which input handle). Read
    both before deciding how to extend the board: the cards tell you
    what exists, the edges tell you what's actually wired to what
    already, so you don't reconnect something that's already connected
    or disconnect a chain you didn't mean to touch.

    Handle rules to keep in mind when connecting things (see
    connect_cards/create_split_card/add_criterion): Dataset/Annotation/
    Review/Union/Filter cards each have one real "output" handle you can
    connect directly. Split/Criterion (and this assistant's own "llm"
    card type) have none of their own -- what they produce is always one
    of their materialized children instead (a Split's "part_0"/
    "part_1", a Criterion's "included"/"excluded"), which only exist
    once that card has actually been Run/evaluated. Note/Milestone/
    Builder cards accept no input at all."""
    db = SessionLocal()
    try:
        study_uuid = uuid.UUID(study_id)
        cards = db.query(WorkflowCard).filter_by(study_id=study_uuid).all()
        by_source: dict[uuid.UUID, dict[str, str]] = {}
        for card in cards:
            if card.materialized_source_card_id is not None and card.materialized_source_handle:
                by_source.setdefault(card.materialized_source_card_id, {})[
                    card.materialized_source_handle
                ] = str(card.id)
        edges = db.query(WorkflowEdge).filter_by(study_id=study_uuid).all()
        return {
            "cards": [
                {
                    "card_id": str(card.id),
                    "type": card.type.value,
                    "title": card.title,
                    "materialized_card_ids": by_source.get(card.id, {}),
                }
                for card in cards
            ],
            "edges": [
                {
                    "source_card_id": str(edge.source_card_id),
                    "source_handle": edge.source_handle,
                    "target_card_id": str(edge.target_card_id),
                    "target_handle": edge.target_handle,
                }
                for edge in edges
            ],
        }
    finally:
        db.close()


@mcp.tool()
def create_dataset_card(study_id: str, title: str) -> dict:
    """Create a new root Dataset card containing every case in the
    study -- the natural starting population for a CONSORT-style
    eligibility pipeline. Use add_criterion afterward to chain the
    first eligibility criterion onto it."""
    db = SessionLocal()
    try:
        study_uuid = uuid.UUID(study_id)
        case_count = db.query(Case).filter_by(study_id=study_uuid).count()
        existing_count = db.query(WorkflowCard).filter_by(study_id=study_uuid).count()
        card = WorkflowCard(
            study_id=study_uuid,
            type=WorkflowCardType.DATASET,
            title=title,
            position_x=80.0 + (existing_count % 6) * 260,
            position_y=80.0 + (existing_count // 6) * 160,
            width=200.0,
            height=90.0,
            config={"mode": "all_cases"},
        )
        db.add(card)
        db.commit()
        return {"card_id": str(card.id), "case_count": case_count}
    finally:
        db.close()


@mcp.tool()
def add_criterion(study_id: str, source_card_id: str, source_handle: str, title: str, criterion: str) -> dict:
    """Add a new Eligibility Criterion card to the board, wired to take
    its input from an existing card's output (e.g. a Dataset's default
    "output", or an earlier criterion's "included"/"excluded" branch --
    see list_board_cards for what's available). Pass either that earlier
    criterion's own card_id with source_handle="included"/"excluded", or
    the id of the Dataset card materialized_card_ids already points to
    for that branch (with any source_handle) -- both resolve to the same
    real wiring. The new card doesn't judge any cases yet -- open its own
    chat session afterward and ask it to evaluate."""
    db = SessionLocal()
    try:
        source_uuid = uuid.UUID(source_card_id)
        source = db.get(WorkflowCard, source_uuid)
        if source is None:
            return {"error": f"No card with id {source_card_id}"}
        actual_source = _resolve_edge_source(db, source, source_handle)
        if not isinstance(actual_source, WorkflowCard):
            return actual_source
        card = WorkflowCard(
            study_id=uuid.UUID(study_id),
            type=WorkflowCardType.CRITERION,
            title=title,
            position_x=source.position_x + 260,
            position_y=source.position_y,
            width=220.0,
            # Tall enough for its own criterion text (up to 2 lines,
            # line-clamped) plus the always-shown included/excluded
            # named-output rows -- matches admin-ui's own default
            # Criterion card height (CardLibrarySidebar/pipelineTemplates.ts).
            height=200.0,
            config={"criterion": criterion, "messages": []},
        )
        db.add(card)
        db.flush()
        edge = WorkflowEdge(
            study_id=uuid.UUID(study_id),
            source_card_id=actual_source.id,
            source_handle="output",
            target_card_id=card.id,
            target_handle="input",
        )
        db.add(edge)
        db.commit()
        return {"card_id": str(card.id)}
    finally:
        db.close()


@mcp.tool()
def create_split_card(
    study_id: str, source_card_id: str, source_handle: str, title: str, parts: list[dict]
) -> dict:
    """Add a new Split card to the board, wired to take its input from an
    existing card's output (same source_card_id/source_handle rules as
    add_criterion -- a Dataset's default "output", or an earlier
    Split/Criterion's own named branch). `parts` is a list of
    {"name": str, "ratio": float} -- e.g. [{"name": "Train", "ratio":
    0.8}, {"name": "Test", "ratio": 0.2}] -- describing how to divide
    the connected cases; ratios are normalized automatically, so they
    don't need to sum to exactly 1. The split itself isn't computed
    yet: this only creates and wires the card. Run it afterward (from
    its own properties panel, or ask for it explicitly) to actually
    partition the connected cases into its named parts."""
    db = SessionLocal()
    try:
        source_uuid = uuid.UUID(source_card_id)
        source = db.get(WorkflowCard, source_uuid)
        if source is None:
            return {"error": f"No card with id {source_card_id}"}
        actual_source = _resolve_edge_source(db, source, source_handle)
        if not isinstance(actual_source, WorkflowCard):
            return actual_source
        card = WorkflowCard(
            study_id=uuid.UUID(study_id),
            type=WorkflowCardType.SPLIT,
            title=title,
            position_x=source.position_x + 260,
            position_y=source.position_y,
            width=220.0,
            height=100.0,
            config={"parts": parts},
        )
        db.add(card)
        db.flush()
        edge = WorkflowEdge(
            study_id=uuid.UUID(study_id),
            source_card_id=actual_source.id,
            source_handle="output",
            target_card_id=card.id,
            target_handle="input",
        )
        db.add(edge)
        db.commit()
        return {"card_id": str(card.id), "note": "Not yet split -- Run this card to partition its connected cases."}
    finally:
        db.close()


@mcp.tool()
def connect_cards(study_id: str, source_card_id: str, source_handle: str, target_card_id: str, target_handle: str) -> dict:
    """Wire a new edge between two cards that already exist on the
    board -- e.g. connecting a Dataset into an existing Criterion or
    Split's input, or chaining one Split part onward. Only ordinary
    data-flow edges (target_handle="input") are supported here, not a
    Surface card's separate "surface_config" channel. source_card_id/
    source_handle follow the same rule as add_criterion/
    create_split_card: pass a card with a real "output" (most types), or
    a Split/Criterion's own card_id with one of its branch names (e.g.
    "part_0", "included") to chain from that branch's materialized
    child -- see list_board_cards for what already exists and is already
    wired. Use this for any connection that add_criterion/
    create_split_card/create_dataset_card don't already cover as part
    of creating a new card."""
    db = SessionLocal()
    try:
        source = db.get(WorkflowCard, uuid.UUID(source_card_id))
        if source is None:
            return {"error": f"No card with id {source_card_id}"}
        target = db.get(WorkflowCard, uuid.UUID(target_card_id))
        if target is None:
            return {"error": f"No card with id {target_card_id}"}
        if source.id == target.id:
            return {"error": "A card cannot connect to itself"}
        if target_handle != "input":
            return {"error": 'Only target_handle="input" is supported here -- Surface cards are out of scope.'}
        if target.type in _NO_REAL_INPUT_TYPES:
            return {"error": f"A {target.type.value} card has no input"}
        actual_source = _resolve_edge_source(db, source, source_handle)
        if not isinstance(actual_source, WorkflowCard):
            return actual_source
        edge = WorkflowEdge(
            study_id=uuid.UUID(study_id),
            source_card_id=actual_source.id,
            source_handle="output",
            target_card_id=target.id,
            target_handle="input",
        )
        db.add(edge)
        db.commit()
        return {"edge_id": str(edge.id)}
    finally:
        db.close()


@mcp.tool()
def evaluate_criterion(card_id: str, included_case_ids: list[str]) -> dict:
    """Judge every case connected to this Criterion card against its one
    stored criterion, and materialize the two named children this card
    always has: "included" (a Dataset of included_case_ids -- the cases
    you decided satisfy the criterion, after using list_cases/
    get_case_details/read_document to look at each one) and "excluded"
    (every other connected case). Re-running this replaces both
    children's contents rather than creating duplicates."""
    db = SessionLocal()
    try:
        card = db.get(WorkflowCard, uuid.UUID(card_id))
        if card is None:
            return {"error": f"No card with id {card_id}"}
        all_case_ids = set(_connected_case_ids(db, card.id))
        included = sorted(all_case_ids & set(included_case_ids))
        excluded = sorted(all_case_ids - set(included))

        existing_children = {
            child.materialized_source_handle: child
            for child in db.query(WorkflowCard).filter_by(materialized_source_card_id=card.id).all()
        }
        for handle, case_ids in (("included", included), ("excluded", excluded)):
            child = existing_children.get(handle)
            if child is not None:
                child.config = {**child.config, "mode": "manual", "case_ids": case_ids}
            else:
                db.add(
                    WorkflowCard(
                        study_id=card.study_id,
                        type=WorkflowCardType.DATASET,
                        title=f"{card.title} -- {handle}",
                        position_x=card.position_x + 260,
                        position_y=card.position_y + (0 if handle == "included" else 140),
                        width=200.0,
                        height=90.0,
                        config={"mode": "manual", "case_ids": case_ids},
                        materialized_source_card_id=card.id,
                        materialized_source_handle=handle,
                    )
                )
        db.commit()
        return {"included_count": len(included), "excluded_count": len(excluded)}
    finally:
        db.close()


@mcp.tool()
def create_dataset(card_id: str, title: str, case_ids: list[str] | None = None) -> dict:
    """Create a new Dataset card on the workflow board. By default (no
    case_ids given) it contains every case currently connected to this
    Clinical Trial Assistant card. Pass an explicit case_ids list --
    after using list_cases/get_case_details/read_document to decide
    which ones qualify -- to create a filtered dataset of just those
    cases instead. The new card is wired up on the board automatically
    -- nothing further is needed after calling this."""
    db = SessionLocal()
    try:
        card = db.get(WorkflowCard, uuid.UUID(card_id))
        if card is None:
            return {"error": f"No card with id {card_id}"}
        resolved_case_ids = case_ids if case_ids is not None else _connected_case_ids(db, card.id)
        existing_children = db.query(WorkflowCard).filter_by(materialized_source_card_id=card.id).count()
        child = WorkflowCard(
            study_id=card.study_id,
            type=WorkflowCardType.DATASET,
            title=title,
            position_x=card.position_x + 260,
            position_y=card.position_y + existing_children * 140,
            width=200.0,
            height=90.0,
            config={"mode": "manual", "case_ids": resolved_case_ids},
            materialized_source_card_id=card.id,
            materialized_source_handle=f"created_{existing_children + 1}",
        )
        db.add(child)
        db.commit()
        return {"dataset_id": str(child.id), "title": title, "case_count": len(resolved_case_ids)}
    finally:
        db.close()


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8000)
