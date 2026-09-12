"""The notification service: emails a person when something about
their jobs changes -- a job newly assigned to them, its status moving
(To do / In progress / Done), or a case in it changing in a way that
needs them (sent back for rework, approved, newly awaiting their
review).

Module layout:
  events.py   re-derives every job's assignee/status/case states on a
              timer, diffs against the last observed snapshot
              (job_notification_state) and turns the difference into
              emails -- the observer model, since job status is computed
              on read rather than written anywhere (see
              workflow.status.compute_job_status), so there's no single
              write path to hook
  mailer.py   SMTP delivery, settings-driven (notification_settings)
  poller.py   the asyncio loop that runs events.run_cycle in the
              background of this service
  api.py      /admin/notifications: settings, test email, run-now,
              status, delivery log, per-user preferences
"""
from .api import router
from .poller import start_poller

__all__ = ["router", "start_poller"]
