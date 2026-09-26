"""Where a card the board makes itself goes (UX-ux-admin-08: a Split's
lanes and a Review's approved/rejected cards landed on top of existing
cards): its usual spot, stepped down past anything it would cover."""
from app.api.workflow.layout import free_spot


def test_an_empty_spot_is_kept():
    assert free_spot((500, 0, 200, 90), []) == (500, 0)
    assert free_spot((500, 0, 200, 90), [(0, 0, 200, 90)]) == (500, 0)


def test_a_covered_spot_steps_below_what_covers_it():
    # a card sits exactly there, another one right under it
    taken = [(500, 0, 200, 90), (520, 100, 200, 120)]
    assert free_spot((500, 0, 200, 90), taken, gap=20) == (500, 240)


def test_touching_edges_count_with_the_gap():
    assert free_spot((500, 0, 200, 90), [(500, 100, 200, 90)], gap=20) == (500, 210)
    assert free_spot((500, 0, 200, 90), [(500, 100, 200, 90)], gap=5) == (500, 0)
