"""Pipeline health: how long a case actually takes to move through the
clinical workflow (not how someone used the UI -- see app/usage -- and
not who changed admin state -- see app/api/audit.py), where cases are
piling up right now, and whether each person is getting faster over
their own tenure.

Module layout:
  stats.py  pure aggregation over "legs" (one entry per (card, case)
            pair with a known queue-start) -- medians, the bottleneck
            threshold, assignee load, the learning curve. No DB.
  api.py    /admin/pipeline-health: builds legs from CaseStageEvent +
            Annotation + AnnotationReview, admin-only.
"""
from .api import router

__all__ = ["router"]
