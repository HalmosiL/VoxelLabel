"""Unit tests for the Clinical Trial module's real chat loop -- only
`_ollama_tools_from_mcp` is meaningfully unit-testable without a live
Ollama + mcp-server round trip (a real model's tool-calling behavior
isn't something a pure-function test can pin down; see this session's
own verification notes for how that part was checked live instead)."""
from types import SimpleNamespace

from app.llm_client import (
    _looks_like_summary_request,
    _ollama_tools_from_mcp,
    _root_cause,
    _summarize_tool_result,
    _tool_error_text,
    _tool_result_data,
)


def _fake_tool(name: str, description: str | None, input_schema: dict) -> SimpleNamespace:
    """Stands in for an MCP SDK Tool object -- only the three attributes
    _ollama_tools_from_mcp actually reads."""
    return SimpleNamespace(name=name, description=description, input_schema=input_schema)


def test_ollama_tools_from_mcp_shapes_a_single_tool() -> None:
    tool = _fake_tool(
        "create_dataset",
        "Create a new Dataset card.",
        {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]},
    )

    result = _ollama_tools_from_mcp([tool])

    assert result == [
        {
            "type": "function",
            "function": {
                "name": "create_dataset",
                "description": "Create a new Dataset card.",
                "parameters": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]},
            },
        }
    ]


def test_ollama_tools_from_mcp_handles_multiple_tools_and_missing_description() -> None:
    tools = [
        _fake_tool("list_connected_data", None, {"type": "object", "properties": {}}),
        _fake_tool("create_dataset", "Create a dataset.", {"type": "object", "properties": {}}),
    ]

    result = _ollama_tools_from_mcp(tools)

    assert [t["function"]["name"] for t in result] == ["list_connected_data", "create_dataset"]
    # A missing description becomes an empty string, not None -- Ollama's
    # schema expects a string field here.
    assert result[0]["function"]["description"] == ""


def test_ollama_tools_from_mcp_empty_list() -> None:
    assert _ollama_tools_from_mcp([]) == []


def _fake_result(structured_content, text: str | None = None) -> SimpleNamespace:
    content = [SimpleNamespace(text=text)] if text is not None else []
    return SimpleNamespace(structured_content=structured_content, content=content)


def test_tool_result_data_prefers_structured_content_when_present() -> None:
    result = _fake_result({"case_count": 3}, text='{"case_count": 999}')
    assert _tool_result_data(result) == {"case_count": 3}


def test_tool_result_data_falls_back_to_parsing_the_text_content() -> None:
    """The real-world case: a tool with a bare `-> dict` return type
    annotation doesn't get structured_content populated by the SDK at
    all (confirmed live against services/mcp-server's own tools) -- the
    JSON has to come from the plain text content block instead."""
    result = _fake_result(None, text='{"case_count": 3, "connected_source_count": 1}')
    assert _tool_result_data(result) == {"case_count": 3, "connected_source_count": 1}


def test_tool_result_data_empty_when_nothing_parseable() -> None:
    assert _tool_result_data(_fake_result(None, text=None)) == {}
    assert _tool_result_data(_fake_result(None, text="not json")) == {}


def test_summarize_tool_result_reports_the_underlying_error() -> None:
    assert _summarize_tool_result("list_cases", {"error": "No card with id x"}, is_error=False) == "No card with id x"
    assert _summarize_tool_result("list_cases", {}, is_error=True) == "tool call failed"


def test_summarize_tool_result_list_cases() -> None:
    data = {"cases": [{"case_id": "a"}, {"case_id": "b"}, {"case_id": "c"}]}
    assert _summarize_tool_result("list_cases", data, is_error=False) == "3 case(s) listed"


def test_summarize_tool_result_get_case_details() -> None:
    data = {"title": "Case 1", "imaging_studies": [{}], "documents": [{}, {}]}
    assert _summarize_tool_result("get_case_details", data, is_error=False) == "Case 1: 1 imaging stud(y/ies), 2 document(s)"


def test_summarize_tool_result_read_document_with_content() -> None:
    data = {"title": "notes.txt", "content": "hello world"}
    assert _summarize_tool_result("read_document", data, is_error=False) == 'read "notes.txt" (11 chars)'


def test_summarize_tool_result_read_document_unreadable() -> None:
    data = {"title": "scan.pdf", "content": None, "content_note": "binary file"}
    assert _summarize_tool_result("read_document", data, is_error=False) == '"scan.pdf" -- binary file'


def test_tool_error_text_reads_the_first_text_content_block() -> None:
    result = _fake_result(None, text="card_id: Field required")
    assert _tool_error_text(result) == "card_id: Field required"


def test_tool_error_text_falls_back_when_no_content() -> None:
    assert _tool_error_text(_fake_result(None, text=None)) == "tool call failed"


def test_summarize_tool_result_uses_raw_error_text_when_data_is_empty() -> None:
    """The real-world failure this guards against: a forced retry made
    the model call a tool with a missing required argument -- the MCP
    validation error isn't JSON, so `data` (from _tool_result_data)
    comes back empty, and the model needs the actual reason to
    self-correct instead of a generic "tool call failed"."""
    assert (
        _summarize_tool_result("list_connected_data", {}, is_error=True, raw_error_text="card_id: Field required")
        == "card_id: Field required"
    )


def test_summarize_tool_result_prefers_a_structured_error_field_over_raw_text() -> None:
    data = {"error": "No card with id x"}
    assert (
        _summarize_tool_result("list_cases", data, is_error=True, raw_error_text="some other raw text")
        == "No card with id x"
    )


def test_summarize_tool_result_list_board_cards() -> None:
    data = {"cards": [{"card_id": "a"}, {"card_id": "b"}], "edges": [{"source_card_id": "a"}]}
    assert _summarize_tool_result("list_board_cards", data, is_error=False) == "2 card(s), 1 edge(s) on the board"


def test_summarize_tool_result_create_dataset_card() -> None:
    data = {"card_id": "abc-123", "case_count": 7}
    assert _summarize_tool_result("create_dataset_card", data, is_error=False) == 'created "abc-123" (7 cases)'


def test_summarize_tool_result_add_criterion() -> None:
    data = {"card_id": "abc-123"}
    assert _summarize_tool_result("add_criterion", data, is_error=False) == "added criterion card abc-123"


def test_summarize_tool_result_evaluate_criterion() -> None:
    data = {"included_count": 3, "excluded_count": 5}
    assert _summarize_tool_result("evaluate_criterion", data, is_error=False) == "3 included, 5 excluded"


def test_summarize_tool_result_create_split_card() -> None:
    data = {"card_id": "abc-123", "note": "Not yet split -- Run this card to partition its connected cases."}
    assert (
        _summarize_tool_result("create_split_card", data, is_error=False)
        == "added split card abc-123 (Not yet split -- Run this card to partition its connected cases.)"
    )


def test_summarize_tool_result_connect_cards() -> None:
    data = {"edge_id": "edge-1"}
    assert _summarize_tool_result("connect_cards", data, is_error=False) == "connected -- edge edge-1"


def test_summarize_tool_result_read_all_documents() -> None:
    data = {"documents_included": 29, "documents_total": 29, "truncated": False}
    assert _summarize_tool_result("read_all_documents", data, is_error=False) == "read 29 of 29 document(s)"


def test_summarize_tool_result_read_all_documents_truncated() -> None:
    data = {"documents_included": 20, "documents_total": 40, "truncated": True}
    assert (
        _summarize_tool_result("read_all_documents", data, is_error=False)
        == "read 20 of 40 document(s) (truncated -- not the whole dataset)"
    )


def test_looks_like_summary_request_matches_english_and_hungarian() -> None:
    assert _looks_like_summary_request("Give me a detailed summary of the dataset")
    assert _looks_like_summary_request("What symptoms occur across the cases?")
    assert _looks_like_summary_request("Készíts egy összefoglalót az esetekről")


def test_looks_like_summary_request_does_not_match_a_plain_question() -> None:
    assert not _looks_like_summary_request("How many cases are connected?")
    assert not _looks_like_summary_request("Create a dataset of everything connected")


def test_root_cause_unwraps_nested_exception_groups() -> None:
    """I-05: the outage message read "unhandled errors in a TaskGroup
    (1 sub-exception)" -- the mcp client nests groups, one unwrap wasn't enough."""
    inner = ConnectionRefusedError(111, "Connection refused")
    nested = ExceptionGroup("outer", [ExceptionGroup("inner", [inner])])
    assert _root_cause(nested) is inner
    assert _root_cause(inner) is inner
