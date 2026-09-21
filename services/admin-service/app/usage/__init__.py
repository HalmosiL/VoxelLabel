"""Usage tracking: how every signed-in person actually uses admin-ui
and the viewer -- which pages, for how long, which actions, clicks,
mouse traces, shortcuts, errors -- recorded so the Usage page can show
where time goes and where people struggle. Distinct from the audit log
(app/api/audit.py), which is the compliance record of admin state
changes; this is UX research data with admin-controlled switches and a
retention limit.

Module layout:
  settings.py  the single usage_settings row (switches, sample rate,
               retention, per-user exclusions), the caller's effective
               config, and the periodic purge
  stats.py     pure aggregation over event rows -- sessions, dwell per
               route, paths, actions, per-user figures, task durations,
               friction signals, click heatmap points; no DB, unit-tested
  api.py       /admin/usage: config + event ingestion for everyone,
               settings and every read for global admins
"""
from .api import router

__all__ = ["router"]
