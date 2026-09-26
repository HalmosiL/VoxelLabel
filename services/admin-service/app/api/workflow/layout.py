"""Placing the cards the board makes itself -- a Split's lanes, a Review's
"(approved)"/"(rejected)", an Annotation's "(annotated)" -- next to their
maker without covering what is already there (UX-ux-admin-08). Pure
geometry over (x, y, width, height) boxes."""

Box = tuple[float, float, float, float]

# The space kept between a placed card and its neighbours.
GAP = 20.0
_MAX_STEPS = 200


def _overlaps(a: Box, b: Box, gap: float) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw + gap and bx < ax + aw + gap and ay < by + bh + gap and by < ay + ah + gap


def free_spot(wanted: Box, taken: list[Box], gap: float = GAP) -> tuple[float, float]:
    """`wanted`'s (x, y), or the first spot straight below it that covers
    nothing in `taken` (keeping `gap` around it)."""
    x, y, w, h = wanted
    for _ in range(_MAX_STEPS):
        blocking = [t for t in taken if _overlaps((x, y, w, h), t, gap)]
        if not blocking:
            return (x, y)
        y = max(t[1] + t[3] for t in blocking) + gap
    return (x, y)
