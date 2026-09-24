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
