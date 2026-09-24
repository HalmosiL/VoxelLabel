"""C-12: a Store template carries a pipeline's structure only. Case ids,
the assignee, the AI chat transcript and the derived job status are
study-specific: they are dropped on save, and templates stored before
that are served without them."""
from shared_models.models import PipelineTemplate

from .conftest import ANNOTATOR_SUBJECT

LEAKY_CARDS = [
    {"key": "a", "type": "dataset", "title": "Pinned", "x": 0, "y": 0, "width": 200, "height": 100,
     "config": {"mode": "manual", "case_ids": ["175eba62-0000-0000-0000-000000000000"]}},
    {"key": "b", "type": "annotation", "title": "Annotate", "x": 300, "y": 0, "width": 200, "height": 100,
     "config": {"status": "done", "assigned_user_id": ANNOTATOR_SUBJECT, "materialize_dataset": True, "labels": ["Nodule"]}},
    {"key": "c", "type": "llm", "title": "Assistant", "x": 600, "y": 0, "width": 200, "height": 100,
     "config": {"messages": [{"role": "user", "content": "private chat about a patient"}]}},
]
GENERIC = [{"mode": "manual"}, {"materialize_dataset": True, "labels": ["Nodule"]}, {}]


def _configs(template):
    return [c["config"] for c in template["cards"]]


def test_saving_a_template_keeps_only_the_structure(client, db):
    r = client.post("/admin/pipeline-templates", json={"title": "tpl", "cards": LEAKY_CARDS, "edges": []})
    assert r.status_code == 201, r.text
    assert _configs(r.json()) == GENERIC
    stored = db.query(PipelineTemplate).one()
    assert [c["config"] for c in stored.cards] == GENERIC
    client.as_user(ANNOTATOR_SUBJECT)
    assert [_configs(t) for t in client.get("/admin/pipeline-templates").json()] == [GENERIC]


def test_a_template_stored_before_the_fix_is_served_without_study_data(client, db):
    db.add(PipelineTemplate(title="old", description="", cards=LEAKY_CARDS, edges=[], created_by="someone"))
    db.commit()
    client.as_user(ANNOTATOR_SUBJECT)
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
