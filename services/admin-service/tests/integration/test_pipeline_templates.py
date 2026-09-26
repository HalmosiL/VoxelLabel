"""C-12: a Store template carries a pipeline's structure only. Case ids,
the assignee, the AI chat transcript and the derived job status are
study-specific: they are dropped on save, and templates stored before
that are served without them."""
from shared_models.models import PipelineTemplate

from .conftest import ANNOTATOR_SUBJECT, DM_SUBJECT, add_member, make_study

LEAKY_CARDS = [
    {"key": "a", "type": "dataset", "title": "Pinned", "x": 0, "y": 0, "width": 200, "height": 100,
     "config": {"mode": "manual", "case_ids": ["175eba62-0000-0000-0000-000000000000"]}},
    {"key": "b", "type": "annotation", "title": "Annotate", "x": 300, "y": 0, "width": 200, "height": 100,
     "config": {"status": "done", "assigned_user_id": ANNOTATOR_SUBJECT, "materialize_dataset": True, "labels": ["Nodule"]}},
    {"key": "c", "type": "llm", "title": "Assistant", "x": 600, "y": 0, "width": 200, "height": 100,
     "config": {"messages": [{"role": "user", "content": "private chat about a patient"}]}},
]
GENERIC = [{"mode": "manual"}, {"materialize_dataset": True, "labels": ["Nodule"]}, {}]


def _another_board_builder(client):
    """Someone else who may read the Store: a data manager of another study (A-09)."""
    add_member(client, make_study(client, "Their study"), DM_SUBJECT, "data_manager")
    client.as_user(DM_SUBJECT)


def _configs(template):
    return [c["config"] for c in template["cards"]]


def test_saving_a_template_keeps_only_the_structure(client, db):
    r = client.post("/admin/pipeline-templates", json={"title": "tpl", "cards": LEAKY_CARDS, "edges": []})
    assert r.status_code == 201, r.text
    assert _configs(r.json()) == GENERIC
    stored = db.query(PipelineTemplate).one()
    assert [c["config"] for c in stored.cards] == GENERIC
    _another_board_builder(client)
    assert [_configs(t) for t in client.get("/admin/pipeline-templates").json()] == [GENERIC]


def test_a_template_stored_before_the_fix_is_served_without_study_data(client, db):
    db.add(PipelineTemplate(title="old", description="", cards=LEAKY_CARDS, edges=[], created_by="someone"))
    db.commit()
    _another_board_builder(client)
    assert [_configs(t) for t in client.get("/admin/pipeline-templates").json()] == [GENERIC]


def _card(key, type_="note"):
    return {"key": key, "type": type_, "title": key, "x": 0, "y": 0, "width": 200, "height": 100, "config": {}}


def test_a_template_that_could_not_be_inserted_is_refused(client, db):
    """C-14: an unknown card type or an edge to a missing card was saved and
    published to everyone's Store; inserting it left half a pipeline."""
    post = lambda cards, edges: client.post("/admin/pipeline-templates", json={"title": "t", "cards": cards, "edges": edges})  # noqa: E731
    edge = lambda s, t, sh="output", th="input": {"source_key": s, "source_handle": sh, "target_key": t, "target_handle": th}  # noqa: E731
    assert post([_card("a"), _card("b", "bogus")], []).status_code == 422
    assert post([_card("a", "surface")], []).status_code == 422
    assert post([_card("a", "dataset")], [edge("a", "zzz")]).status_code == 422
    assert post([_card("a", "dataset"), _card("a", "annotation")], []).status_code == 422  # duplicate key
    assert post([_card("a", "dataset"), _card("b", "annotation")], [edge("a", "b", th="bogus")]).status_code == 422
    assert post([_card("a", "dataset"), _card("b", "annotation")], [edge("a", "b")]).status_code == 201


def test_a_template_keeps_the_connections_of_cards_its_makers_create(client, db):
    """K5: a card a Split or Review makes when it runs (Lane A,
    "... (rejected)") is not stored as a card any more -- inserting ran the
    maker and left a second, empty Lane A wired to the job. Its connection
    is kept as `feedback` (maker key + output handle -> target), checked
    like the edges."""
    cards = [_card("split", "split"), _card("annot", "annotation"), _card("review", "review")]
    body = {
        "title": "two lanes", "cards": cards,
        "edges": [{"source_key": "annot", "source_handle": "output", "target_key": "review", "target_handle": "input"}],
        "feedback": [
            {"source_key": "split", "source_handle": "part_0", "target_key": "annot", "target_handle": "input"},
            {"source_key": "review", "source_handle": "rejected", "target_key": "annot", "target_handle": "input"},
        ],
    }
    r = client.post("/admin/pipeline-templates", json=body)
    assert r.status_code == 201, r.text
    stored = next(t for t in client.get("/admin/pipeline-templates").json() if t["id"] == r.json()["id"])
    assert stored["feedback"] == body["feedback"]
    bad = {**body, "feedback": [{"source_key": "nope", "source_handle": "part_0", "target_key": "annot", "target_handle": "input"}]}
    assert client.post("/admin/pipeline-templates", json=bad).status_code == 422
    no_maker = {**body, "feedback": [{"source_key": "annot", "source_handle": "part_0", "target_key": "review", "target_handle": "input"}]}
    assert client.post("/admin/pipeline-templates", json=no_maker).status_code == 422  # an annotation makes no "part_0"
