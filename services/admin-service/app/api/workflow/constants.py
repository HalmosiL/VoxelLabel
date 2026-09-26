"""Card-type sets and defaults shared by every workflow module."""
from shared_models.models import WorkflowCardType

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]

_WRITE_ROLES = ["data_manager", "admin"]

# Split has no output handle of its own: its result is expressed entirely
# as materialized Dataset cards (see run_workflow_card), not a graph edge.
# The two Surface types (Annotation/Review) are pure configuration --
# they never sit in the case-flow graph, so for the ordinary
# "input"/"output" data-flow handles they behave like Note/Milestone (no
# data output, no data input, never Run). Each still connects to its own
# matching job-card type, but only via the separate "surface_config"
# handle pair, validated on its own in create_workflow_edge below -- that
# check runs before these sets are ever consulted for a surface_config
# edge. SURFACE (the old, single generic type both were split from) is
# included too, purely so a stray pre-existing row of that type can't
# accidentally become a data-flow node -- no new card is ever created
# with it.
_SURFACE_TYPES = {WorkflowCardType.SURFACE, WorkflowCardType.ANNOTATION_SURFACE, WorkflowCardType.REVIEW_SURFACE}

# LLM (the Clinical Trial module's real chat card, driven by a local
# model over MCP) has a real "input" -- Dataset(s) wired in as its
# connected data sources -- but no real "output" of its own: like
# Split, what it produces is expressed as named materialized Dataset
# children (see llm_chat), not a graph edge, and it's never Run in the
# batch sense (a chat message drives it instead), so it's
# _NO_OUTPUT_TYPES and _NO_RUN_TYPES but *not* _NO_INPUT_TYPES.
# BUILDER (the Pipeline Builder chat card) is scoped to the whole Study
# rather than to connected data -- it has no input or output edges at
# all, structurally like Note/Milestone, but is chat-capable like LLM.
# CRITERION (a per-eligibility-criterion chat sub-agent) mirrors LLM's
# shape exactly: a real "input" (the population it judges), no real
# output of its own (it always materializes named "included"/"excluded"
# Dataset children instead, via evaluate_criterion -- see llm_chat).
# Unlike LLM/Builder, Criterion's one useful action ("evaluate every
# connected case against my stored criterion") is well-defined and
# repeatable -- not open-ended chat -- so it's the one chat-capable
# type that's also a RUNNABLE_TYPES/Run target: see _run_one_card's own
# CRITERION branch, which is a canned-message shortcut through the same
# run_llm_turn loop, not a separate deterministic implementation.
_NO_OUTPUT_TYPES = {
    WorkflowCardType.SPLIT,
    WorkflowCardType.NOTE,
    WorkflowCardType.MILESTONE,
    WorkflowCardType.LLM,
    WorkflowCardType.BUILDER,
    WorkflowCardType.CRITERION,
    *_SURFACE_TYPES,
}

# Dataset CAN take an incoming edge -- connecting something into it and
# running it snapshots that upstream result as this Dataset's manual case
# list (a user-placed, general version of Split/Annotation/Review's
# automatic "materialize" -- see the DATASET branch in run_workflow_card).
_NO_INPUT_TYPES = {WorkflowCardType.NOTE, WorkflowCardType.MILESTONE, WorkflowCardType.BUILDER, *_SURFACE_TYPES}

_NO_RUN_TYPES = {
    WorkflowCardType.NOTE,
    WorkflowCardType.MILESTONE,
    WorkflowCardType.LLM,
    WorkflowCardType.BUILDER,
    *_SURFACE_TYPES,
}

_MATERIALIZED_DEFAULT_WIDTH = 200.0

_MATERIALIZED_DEFAULT_HEIGHT = 90.0

# The permissive default returned by get_surface_config when an
# Annotation/Review card has no Surface card connected -- keeps
# unrestricted jobs (the common case today) behaving exactly as before
# this feature existed. A Review job's *effective* config always forces
# tools=[] and show_3d=False regardless of this default or of an
# ANNOTATION_SURFACE's own fields (see get_surface_config) -- the review
# surface has no tools or 3D at all, unconditionally.
_UNRESTRICTED_SURFACE_CONFIG = {
    "tools": ["paint", "erase", "fill", "polygon", "auto", "histogram"],
    "panes": ["sagittal", "coronal", "axial"],
    "show_3d": True,
    # No pre-defined labels by default -- an annotator types their own
    # "New label" name in ct-annotator, exactly as before this field
    # existed. An Annotation Surface can pre-populate this list (e.g.
    # "Nodule") so every annotator on a study creates instances under
    # the same, consistently-named/colored label instead of each typing
    # their own. Review jobs never see labels (nothing to paint), so
    # this is never forced/overridden the way tools/show_3d are below.
    # Each label may carry `fields` (see ct-annotator's
    # components/ObjectForm.tsx): [{name, kind: check|choice|scale,
    # options, min, max}] -- the per-object form an annotator fills next
    # to the instance's comment, and the reviewer sees on the review card.
    "labels": [],
    # the image's own window when a case opens (K8: a Surface can name a preset)
    "default_window": None,
    # questions answered once per case, not per object ("No finding",
    # image quality) -- the same field shape as a label's `fields`
    # (UX-ux-admin-16)
    "case_fields": [],
}
