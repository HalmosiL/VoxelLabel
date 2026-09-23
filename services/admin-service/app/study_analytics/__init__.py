"""Per-study workflow analytics: how the cases of one study went through
its workflow -- see api.py (loading) and stats.py (the figures)."""
from .api import router

__all__ = ["router"]
