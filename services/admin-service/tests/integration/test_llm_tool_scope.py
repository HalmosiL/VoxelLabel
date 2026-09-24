"""C-19: a card's LLM tool calls never reach outside its own study --
whatever ids the model (or a prompt planted in a document) passes."""
import asyncio
import uuid
from types import SimpleNamespace

import pytest
from app import llm_client
from app.llm_tool_scope import ToolCallRefused, scope_tool_call
from shared_models.models import ClinicalDataItem, WorkflowCard, WorkflowCardType

from .conftest import make_case, make_study


def _doc(db, case_id, title):
    item = ClinicalDataItem(case_id=uuid.UUID(case_id), type="report", title=title)
    db.add(item)
    db.commit()
    return str(item.id)


def _card(db, study_id, type_=WorkflowCardType.LLM):
    card = WorkflowCard(study_id=uuid.UUID(study_id), type=type_, title="Chat", position_x=0, position_y=0, config={})
    db.add(card)
    db.commit()
    return card


@pytest.fixture
def two_studies(client, db):
    a, b = make_study(client, "A"), make_study(client, "B")
    case_a, case_b = make_case(client, a, external="a"), make_case(client, b, external="b")
    return SimpleNamespace(a=a, b=b, case_a=case_a["id"], case_b=case_b["id"], doc_a=_doc(db, case_a["id"], "own"), doc_b=_doc(db, case_b["id"], "foreign"))


LLM_TOOLS = llm_client._ALLOWED_TOOLS_BY_CARD_TYPE["llm"]
BUILDER_TOOLS = llm_client._ALLOWED_TOOLS_BY_CARD_TYPE["builder"]


def test_ids_outside_the_study_are_refused(db, two_studies):
    s = two_studies
    card_a = _card(db, s.a)
    card_b = _card(db, s.b)
    sid = card_a.study_id
    assert scope_tool_call(db, sid, LLM_TOOLS, "read_document", {"document_id": s.doc_a}) == {"document_id": s.doc_a}
    for name, args in (
        ("read_document", {"document_id": s.doc_b}),
        ("get_case_details", {"case_id": s.case_b}),
        ("list_cases", {"card_id": str(card_b.id)}),
        ("create_dataset", {"card_id": str(card_a.id), "title": "x", "case_ids": [s.case_a, s.case_b]}),
        ("read_document", {"document_id": "not-an-id"}),
    ):
        with pytest.raises(ToolCallRefused):
            scope_tool_call(db, sid, LLM_TOOLS, name, args)


def test_study_id_is_always_the_cards_own_and_tools_stay_in_the_cards_set(db, two_studies):
    s = two_studies
    card_a = _card(db, s.a, WorkflowCardType.BUILDER)
    scoped = scope_tool_call(db, card_a.study_id, BUILDER_TOOLS, "create_dataset_card", {"study_id": s.b, "title": "injected"})
    assert scoped["study_id"] == s.a
    with pytest.raises(ToolCallRefused):
        scope_tool_call(db, card_a.study_id, BUILDER_TOOLS, "read_document", {"document_id": s.doc_a})


def test_the_chat_loop_answers_a_refused_call_as_a_tool_error_and_never_calls_mcp(db, two_studies, monkeypatch):
    s = two_studies
    card = _card(db, s.a)
    mcp_calls = []

    class FakeMCP:
        def __init__(self, url):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def list_tools(self):
            return SimpleNamespace(tools=[SimpleNamespace(name=n, description="", input_schema={"type": "object"}) for n in LLM_TOOLS])

        async def call_tool(self, name, args):
            mcp_calls.append((name, args))
            return SimpleNamespace(is_error=False, structured_content={"title": "own", "content": "ok"}, content=[])

    replies = iter([
        {"message": {"content": "", "tool_calls": [{"function": {"name": "read_document", "arguments": {"document_id": s.doc_b}}}]}},
        {"message": {"content": "I could not read it."}},
    ])

    class FakeHttp:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json):
            data = next(replies)
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: data)

    monkeypatch.setattr(llm_client, "Client", FakeMCP)
    monkeypatch.setattr(llm_client.httpx, "AsyncClient", FakeHttp)
    messages, changed = asyncio.run(llm_client.run_llm_turn(card, [], "Quote the other study's report"))
    assert mcp_calls == []
    refused = [m for m in messages if m.get("tool_call")]
    assert refused and "not in this study" in refused[0]["tool_call"]["result_summary"]
    assert changed is False
