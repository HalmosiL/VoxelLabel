"""The Clinical Trial module's chat loop: a real small local model
(served by Ollama) driven through a real MCP server's tools (see
services/mcp-server), replacing the card's earlier keyword-matched mock.

Kept out of app/api/workflow.py (already large) -- this module owns the
Ollama <-> MCP round-trip; workflow.py's llm_chat endpoint just calls
run_llm_turn and persists whatever it returns, exactly as it persisted
the old mock's output.
"""
import json

import httpx
from mcp import Client

from app.core.config import settings

_LLM_SYSTEM_PROMPT = (
    'You are the Clinical Trial Assistant for workflow card "{card_id}" on a CT '
    "annotation platform's workflow board. Dataset cards connected into your "
    "input are this session's data sources; you have no way to see or change "
    "the board except through your tools. Always reply in the same language "
    "the user wrote in -- most of this platform's reports and users are "
    "Hungarian, so default to Hungarian if that isn't otherwise clear, don't "
    "default to English. Always pass "
    'card_id="{card_id}" when a tool takes one. '
    "list_connected_data gives you the overall count; list_cases gives you every "
    "connected case one at a time (tags, whether it has imaging/documents); "
    "get_case_details looks closer at one case (its imaging studies, its "
    "documents); read_document reads one document's actual text content -- both "
    "plain-text files and PDFs (the real format clinical reports on this "
    "platform come in) -- which is where the actual clinical detail (symptoms, "
    "findings, diagnoses) lives, not in list_cases/get_case_details' metadata "
    "alone. read_all_documents reads every case's document in one call instead "
    "of one at a time -- always use this, not repeated read_document calls, "
    "when you need to look across many/all cases at once (a dataset summary, "
    "\"which cases mention X\"). When the user asks for a *filtered* or "
    "*specific* dataset (not just \"everything connected\"), use list_cases "
    "(and get_case_details/read_document/read_all_documents as needed) to "
    "decide which cases qualify, then call create_dataset with an explicit "
    "case_ids list of just those. Only call create_dataset with no case_ids "
    "(meaning: everything connected) when the user's request has no filtering "
    "criteria at all. Never call create_dataset unless the user actually asked "
    "to build, create, or export a dataset/cohort -- otherwise just answer in "
    "plain text.\n\n"
    "When asked for a summary, overview, or analysis of the connected data "
    "(e.g. what conditions/symptoms occur, how cases break down by finding or "
    "diagnosis), give a real, thorough answer, not a one-liner: call "
    "read_all_documents to actually ground the summary in what the reports "
    "say (if it reports truncated=true, say in your answer that this only "
    "covers part of the dataset), then write it up with real structure -- "
    "group related findings, call out how many cases each group covers, note "
    "anything that stood out. Long, detailed answers are expected and welcome "
    "for this kind of request. For a quick factual question (a count, whether "
    "one case has something), stay concise instead -- match the reply's "
    "length to what was actually asked, don't pad a simple answer.\n\n"
    "Two hard rules for any summary, no matter how it's phrased:\n"
    "1. Every case is its own patient with its own findings -- read_all_"
    "documents gives you each document's own case_id/case_title precisely so "
    "you never blend two different cases' findings into one description. If "
    "you're describing what one case shows, say which case (by title or "
    "id); if you're describing a pattern across several, say how many and "
    "which. Never write as if all the connected cases were "
    "one patient's combined chart.\n"
    "2. You report what the documents say -- you do not practice medicine. "
    "Never judge whether a diagnosis or treatment plan is \"appropriate\", "
    "\"correct\", or \"sufficient\", never issue a recommendation (\"continue "
    "treatment\", \"consult a specialist\"), and never invent a clinical "
    "conclusion the text itself doesn't state. Describe what's documented "
    "(stage, findings, treatment given) and leave any judgment about it to "
    "the clinicians using this platform."
)

_BUILDER_SYSTEM_PROMPT = (
    'You are the Pipeline Builder for study "{study_id}" on a CT annotation '
    "platform's workflow board. Your job is to help the user design and "
    "construct a CONSORT-style eligibility pipeline directly on the board: a "
    "root Dataset of the whole study population, followed by a chain of "
    "Eligibility Criterion (and, where useful, Split) cards, each narrowing "
    "or dividing the population by one rule. The board itself is the CONSORT "
    "flow diagram -- there is no separate diagram to draw.\n\n"
    "Always start by calling list_board_cards to see the graph as it actually "
    "is right now: every card, AND every real edge between them (which "
    "card's output feeds which card's input). Read the edges, not just the "
    "card list, before deciding what to add or connect -- that's the only way "
    "to know what's already wired versus still needs connecting, and to find "
    "an existing card to extend rather than duplicating it.\n\n"
    "How cards connect (get this right or a tool call will fail):\n"
    "- Dataset, Annotation, Review, Union, and Filter cards each have one "
    "real \"output\" you can connect a new card's input to directly.\n"
    "- Split and Criterion cards have no output of their own -- what they "
    "produce is always one of their named materialized children instead "
    "(a Split's \"part_0\"/\"part_1\"/..., a Criterion's \"included\"/"
    "\"excluded\"), and those children only exist once that card has "
    "actually been Run (Split) or evaluated (Criterion, in its own chat "
    "session -- you cannot do that yourself). To chain onto one of these, "
    "pass that Split/Criterion's own card_id as source_card_id and the "
    "branch name (e.g. \"included\") as source_handle -- every tool that "
    "wires an edge resolves this to the right underlying Dataset "
    "automatically. If that branch doesn't exist yet, the tool will tell "
    "you so and you should tell the user to Run/evaluate that card first.\n"
    "- Note/Milestone cards take no input at all -- never target one.\n\n"
    "Tools: create_dataset_card makes a new root \"all cases\" Dataset. "
    "add_criterion adds a new Eligibility Criterion card wired to a given "
    "source (keep its criterion text short and concrete, e.g. \"age >= 18\", "
    "\"has a baseline imaging study\" -- it becomes that card's own "
    "instructions). create_split_card adds a Split card wired to a given "
    "source with named parts and ratios (e.g. Train/Test 0.8/0.2) -- it "
    "isn't computed until Run, so tell the user to Run it afterward. "
    "connect_cards wires an edge between two cards that already exist, for "
    "anything the creation tools above don't already cover as part of "
    "adding a new card. Keep replies short."
)

_CRITERION_SYSTEM_PROMPT = (
    'You are one Eligibility Criterion sub-agent (workflow card "{card_id}", '
    'study "{study_id}") in a CONSORT-style eligibility pipeline on a CT '
    "annotation platform's workflow board. Your one job is to decide, for "
    "each case connected into your input, whether it satisfies this "
    "criterion: \"{criterion}\". Always pass "
    'card_id="{card_id}" when a tool takes one. Use list_cases to see every '
    "connected case (tags, whether it has imaging/documents), and "
    "get_case_details/read_document to look closer at any case the tags alone "
    "don't settle -- or read_all_documents to read every case's document in "
    "one call instead of one at a time, which is more reliable when most or "
    "all of the connected cases need their document actually read to judge "
    "the criterion. Once you've judged every connected case, call "
    "evaluate_criterion with included_case_ids set to exactly the cases that "
    "satisfy the criterion -- everything else connected is automatically "
    "treated as excluded. Re-running evaluate_criterion replaces the previous "
    "included/excluded split rather than duplicating it, so it's fine to "
    "re-evaluate after the user corrects you. Don't call evaluate_criterion "
    "until you've actually looked at the connected cases first. Keep replies "
    "short."
)

# Which of the MCP server's tools each card type's model is even shown --
# a 1.7B model does better with a small, unambiguous tool set scoped to
# its one job than all nine regardless of role.
_ALLOWED_TOOLS_BY_CARD_TYPE = {
    "llm": {
        "list_connected_data",
        "list_cases",
        "get_case_details",
        "read_document",
        "read_all_documents",
        "create_dataset",
    },
    "builder": {"list_board_cards", "create_dataset_card", "add_criterion", "create_split_card", "connect_cards"},
    "criterion": {"list_cases", "get_case_details", "read_document", "read_all_documents", "evaluate_criterion"},
}

# Tools that actually change the board -- run_llm_turn's returned
# board_changed flag is true whenever any of these succeeded this turn
# (drives the frontend's "refetch the board" decision after a chat
# reply, same trigger that create_dataset alone used to be).
_BOARD_MUTATING_TOOLS = {
    "create_dataset",
    "create_dataset_card",
    "add_criterion",
    "evaluate_criterion",
    "create_split_card",
    "connect_cards",
}

# Guards against a small model getting stuck calling tools indefinitely
# instead of ever producing a final answer. Higher than a single-lookup
# card would need, deliberately -- a real "go through each connected case
# and decide" filtering request, or a "summarize what's in this dataset"
# request that reads several cases' documents one at a time (get_case_
# details then read_document, per case), can legitimately take many
# rounds for a dataset of a few dozen cases, not just one or two calls.
_MAX_TOOL_ROUNDS = 30

_TOOL_INTRO_TEXT = {
    "list_connected_data": "Let me check what's connected right now...",
    "list_cases": "Let me look through the connected cases...",
    "get_case_details": "Let me take a closer look at that case...",
    "read_document": "Let me read that document...",
    "read_all_documents": "Let me read through every document in this dataset...",
    "create_dataset": "Creating that dataset now...",
    "list_board_cards": "Let me see what's already on the board...",
    "create_dataset_card": "Creating the starting population dataset...",
    "add_criterion": "Adding that criterion to the board...",
    "evaluate_criterion": "Evaluating this criterion against the connected cases...",
    "create_split_card": "Adding that split to the board...",
    "connect_cards": "Connecting those cards...",
}


def _ollama_tools_from_mcp(tools) -> list[dict]:
    """Converts an MCP ListToolsResult's tools into Ollama's /api/chat
    `tools` shape (OpenAI-style function-calling schema) -- pure, no
    network/model involved, so this is the one part of the loop that's
    meaningfully unit-testable."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.input_schema,
            },
        }
        for tool in tools
    ]


def _tool_result_data(result) -> dict:
    """Pulls the actual JSON payload out of an MCP CallToolResult.
    `structured_content` is only populated when a tool's return type
    annotation is concrete enough for the SDK to derive an output
    schema from (a bare `-> dict`, like every one of the MCP server's
    tools uses, isn't) -- so this always falls back to parsing the plain-text
    content block, which is what a dict return actually comes back as."""
    if result.structured_content:
        return result.structured_content
    for item in result.content or []:
        text = getattr(item, "text", None)
        if text:
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                continue
    return {}


def _tool_error_text(result) -> str:
    """The raw text of a *failed* call -- e.g. an MCP argument-validation
    error ("card_id: Field required") isn't JSON, so _tool_result_data's
    json.loads silently comes back empty for it, which used to discard
    exactly the detail a model needs to correct itself on a retry."""
    for item in result.content or []:
        text = getattr(item, "text", None)
        if text:
            return text
    return "tool call failed"


def _summarize_tool_result(name: str, data: dict, is_error: bool, raw_error_text: str = "tool call failed") -> str:
    if is_error:
        return data.get("error", raw_error_text) if data else raw_error_text
    if "error" in data:
        return data["error"]
    if name == "create_dataset":
        return f'created "{data.get("title")}" ({data.get("case_count", 0)} cases)'
    if name == "list_connected_data":
        return f'{data.get("case_count", 0)} case(s) across {data.get("connected_source_count", 0)} source(s)'
    if name == "list_cases":
        return f'{len(data.get("cases", []))} case(s) listed'
    if name == "get_case_details":
        return f'{data.get("title") or data.get("case_id", "case")}: {len(data.get("imaging_studies", []))} imaging stud(y/ies), {len(data.get("documents", []))} document(s)'
    if name == "read_document":
        if data.get("content") is not None:
            return f'read "{data.get("title")}" ({len(data["content"])} chars)'
        return f'"{data.get("title")}" -- {data.get("content_note", "not readable")}'
    if name == "read_all_documents":
        note = " (truncated -- not the whole dataset)" if data.get("truncated") else ""
        return f'read {data.get("documents_included", 0)} of {data.get("documents_total", 0)} document(s){note}'
    if name == "list_board_cards":
        return f'{len(data.get("cards", []))} card(s), {len(data.get("edges", []))} edge(s) on the board'
    if name == "create_dataset_card":
        return f'created "{data.get("card_id", "dataset")}" ({data.get("case_count", 0)} cases)'
    if name == "add_criterion":
        return f'added criterion card {data.get("card_id", "")}'
    if name == "evaluate_criterion":
        return f'{data.get("included_count", 0)} included, {data.get("excluded_count", 0)} excluded'
    if name == "create_split_card":
        return f'added split card {data.get("card_id", "")} ({data.get("note", "")})'
    if name == "connect_cards":
        return f'connected -- edge {data.get("edge_id", "")}'
    return json.dumps(data)


# A cheap, deterministic heuristic (English + Hungarian) for "this
# message wants a dataset-wide summary/analysis" -- used to force at
# least one real content-reading tool call before accepting an answer
# (see run_llm_turn's required_tool_names guard). Needed because a small
# model asked for a "detailed summary" will sometimes skip straight to
# fabricating plausible-sounding findings instead of actually calling
# read_all_documents -- confirmed live: qwen3:1.7b invented conditions
# ("Pneumonia (n=8)", "Hypertension (n=5)") that don't exist anywhere in
# the real connected data, after calling only list_connected_data. This
# can't be left to the model's own judgment about whether it has "enough"
# to answer -- it doesn't reliably have that judgment at this size.
_SUMMARY_REQUEST_KEYWORDS = (
    "summar", "overview", "analy", "symptom", "finding", "diagnos", "condition", "occur",
    "összefoglal", "áttekint", "elemz", "tünet", "lelet", "diagnóz", "előfordul",
)


def _looks_like_summary_request(message: str) -> bool:
    lowered = message.lower()
    return any(keyword in lowered for keyword in _SUMMARY_REQUEST_KEYWORDS)


def _system_prompt_for(card) -> str:
    """The system prompt for this card's role -- LLM, Builder, or
    Criterion each get their own, since each has a different job and a
    different filtered tool set (see _ALLOWED_TOOLS_BY_CARD_TYPE)."""
    card_type = card.type.value
    if card_type == "builder":
        return _BUILDER_SYSTEM_PROMPT.format(study_id=card.study_id)
    if card_type == "criterion":
        return _CRITERION_SYSTEM_PROMPT.format(
            card_id=card.id,
            study_id=card.study_id,
            criterion=card.config.get("criterion", "(no criterion text set)"),
        )
    return _LLM_SYSTEM_PROMPT.format(card_id=card.id)


async def run_llm_turn(card, history: list[dict], user_message: str) -> tuple[list[dict], bool]:
    """Runs one user turn through the real model + MCP tool loop, using
    the system prompt and tool subset appropriate to this card's role
    (LLM, Builder, or Criterion -- see _system_prompt_for /
    _ALLOWED_TOOLS_BY_CARD_TYPE). `history` is the card's existing
    config["messages"] (before this turn); returns the *new* messages
    to append (already shaped as {"role", "content", "tool_call"},
    matching the frontend's LlmChatMessage exactly -- so nothing there
    needs to change) and whether any board-mutating tool actually ran
    (for the endpoint's own "board_changed" flag, which drives the
    board refresh)."""
    card_id = str(card.id)
    # Builder's tools take study_id, not card_id -- the forced-tool-use
    # nudge below needs to remind the model of whichever one its own
    # tool set actually expects.
    id_hint = f'study_id="{card.study_id}"' if card.type.value == "builder" else f'card_id="{card_id}"'
    allowed_tool_names = _ALLOWED_TOOLS_BY_CARD_TYPE.get(card.type.value, set())
    new_messages: list[dict] = [{"role": "user", "content": user_message, "tool_call": None}]
    board_changed = False

    ollama_messages = [{"role": "system", "content": _system_prompt_for(card)}]
    ollama_messages.extend({"role": m["role"], "content": m["content"]} for m in history)
    ollama_messages.append({"role": "user", "content": user_message})

    # Ollama has no OpenAI-style tool_choice="required" -- there's no
    # request flag that guarantees a tool gets called, so this is
    # enforced here instead: a small model would sometimes answer a
    # data/case question straight from its own memory of earlier turns
    # rather than checking current state (the whole point of a
    # connected-data assistant is that the board can change under it, so
    # that's never actually trustworthy). If its very first response to
    # this message skips every tool, it gets exactly one corrective nudge
    # to reconsider before a plain-text answer is accepted -- once it
    # has called *any* tool this turn, its eventual wrap-up reply is
    # accepted immediately, same as before.
    any_tool_called = False
    forced_tool_use_attempted = False
    # A second, separate guard on top of the generic one above: some
    # card-type/message combinations have one specific tool that
    # actually has to be called before a final answer means anything --
    # not just *a* tool, but *the* one that does the real work. Confirmed
    # live twice now: a Criterion turn that only calls list_cases and
    # then stops (never calling evaluate_criterion) produces an empty
    # "final answer" instead of an actual decision; an LLM summary
    # request that only calls list_connected_data does the same instead
    # of ever reading real document content. Neither can be left to the
    # model's own judgment about whether it's "done" -- it doesn't
    # reliably have that judgment at this size.
    required_tool_names: set[str] | None = None
    required_tool_nudge = ""
    if card.type.value == "criterion":
        required_tool_names = {"evaluate_criterion"}
        required_tool_nudge = (
            "You must actually call evaluate_criterion before answering -- don't stop after just "
            "listing/reading cases. Look at the connected cases (list_cases, then get_case_details/"
            "read_document/read_all_documents as needed), decide which satisfy the criterion, then call "
            f'evaluate_criterion(card_id="{card_id}", included_case_ids=[...]) with that decision.'
        )
    elif card.type.value == "llm" and _looks_like_summary_request(user_message):
        required_tool_names = {"read_document", "read_all_documents"}
        required_tool_nudge = (
            "You haven't actually read any document's real content yet -- call "
            f'read_all_documents now (card_id="{card_id}") before answering. A summary has to be grounded '
            "in what the reports actually say, not a plausible-sounding guess."
        )
    required_tool_called = False
    forced_required_tool_attempted = False

    try:
        async with Client(settings.mcp_server_url) as mcp_client:
            tools_result = await mcp_client.list_tools()
            # Only expose this card type's own tool subset to the model --
            # a Builder never sees evaluate_criterion, a Criterion never
            # sees create_dataset_card, etc. (see _ALLOWED_TOOLS_BY_CARD_TYPE).
            allowed_tools = [t for t in tools_result.tools if t.name in allowed_tool_names]
            ollama_tools = _ollama_tools_from_mcp(allowed_tools)

            # Long enough for a genuinely long session: a bigger num_ctx
            # (below) plus a long, detailed final answer against a
            # modest GPU can take several minutes for a single round,
            # not just the handful of seconds a short lookup needs --
            # 120s (then 300s) both turned out too tight for this,
            # surfacing as an httpx.ReadTimeout (see the except clause
            # below, which now also has to catch that).
            async with httpx.AsyncClient(timeout=600.0) as http:
                for _ in range(_MAX_TOOL_ROUNDS):
                    response = await http.post(
                        f"{settings.ollama_base_url}/api/chat",
                        json={
                            "model": settings.ollama_model,
                            "messages": ollama_messages,
                            "tools": ollama_tools,
                            "think": True,
                            "stream": False,
                            "options": {
                                # Ollama's own layer-placement heuristic
                                # left ~25% on CPU by default even with
                                # GPU VRAM to spare (confirmed live:
                                # `ollama ps` showed 77%/23% GPU/CPU) --
                                # forcing every layer onto the GPU (99
                                # asks for "as many as exist") took a
                                # real, warm turn from ~11s to ~8s and
                                # made timing consistent instead of
                                # partly CPU-bottlenecked.
                                "num_gpu": 99,
                                # The model's default context (as low as
                                # 2048-4096 depending on the Modelfile)
                                # doesn't leave much room once list_cases'
                                # own JSON for a few dozen cases, a long
                                # "thinking" trace, and a real answer are
                                # all in flight at once -- confirmed live:
                                # a Criterion turn over 30 cases correctly
                                # reasoned its way to "call evaluate_
                                # criterion with these included_case_ids"
                                # entirely within `thinking`, then produced
                                # *no* tool call at all, almost certainly
                                # because the context/output budget ran
                                # out right as it needed to actually emit
                                # that call. This model is small enough
                                # that a much bigger KV cache still
                                # comfortably fits a 4GB card.
                                "num_ctx": 16384,
                                # Generous cap for a real detailed summary
                                # or a long per-case reasoning trace before
                                # the actual tool call -- not unlimited, so
                                # one runaway generation can't eat the
                                # whole remaining context budget.
                                "num_predict": 4096,
                            },
                        },
                    )
                    response.raise_for_status()
                    message = response.json()["message"]
                    tool_calls = message.get("tool_calls") or []
                    # Absent entirely for a model with no "thinking" mode
                    # (e.g. granite4.1:3b) -- None either way, not "".
                    thinking = message.get("thinking") or None

                    if not tool_calls:
                        if not any_tool_called and not forced_tool_use_attempted:
                            forced_tool_use_attempted = True
                            ollama_messages.append(message)
                            ollama_messages.append(
                                {
                                    "role": "user",
                                    "content": (
                                        "You must call one of your tools before answering -- don't rely on "
                                        "anything you already said earlier in this conversation, the board "
                                        "may have changed since then. Call whichever tool is most relevant now, "
                                        f"and remember to pass {id_hint} if it takes one -- every "
                                        "tool needs either that or a case_id/document_id from a previous result."
                                    ),
                                }
                            )
                            continue
                        if required_tool_names and not required_tool_called and not forced_required_tool_attempted:
                            forced_required_tool_attempted = True
                            ollama_messages.append(message)
                            ollama_messages.append({"role": "user", "content": required_tool_nudge})
                            continue
                        new_messages.append(
                            {
                                "role": "assistant",
                                "content": message.get("content", ""),
                                "tool_call": None,
                                "thinking": thinking,
                            }
                        )
                        return new_messages, board_changed

                    any_tool_called = True
                    ollama_messages.append(message)
                    # Every tool this round's single reasoning pass led
                    # to -- shown alongside the Thinking block itself
                    # (which also only appears once, on the first
                    # message below) so it's clear at a glance what that
                    # reasoning actually resulted in, without needing to
                    # expand it and read through to the end.
                    tool_names_this_round = [call["function"]["name"] for call in tool_calls]
                    for index, call in enumerate(tool_calls):
                        name = call["function"]["name"]
                        args = call["function"]["arguments"]  # already a parsed dict, not a JSON string
                        result = await mcp_client.call_tool(name, args)
                        result_data = _tool_result_data(result)
                        if name in _BOARD_MUTATING_TOOLS and not result.is_error:
                            board_changed = True
                        if required_tool_names and name in required_tool_names and not result.is_error:
                            required_tool_called = True
                        summary = _summarize_tool_result(
                            name, result_data, result.is_error, _tool_error_text(result) if result.is_error else ""
                        )
                        previous = new_messages[-1] if new_messages else None
                        if (
                            previous
                            and previous.get("tool_call")
                            and previous["tool_call"].get("name") == name
                            and previous["tool_call"].get("args") == args
                        ):
                            # The model re-issued the exact same call (a
                            # retry after a nudge, typically) -- refresh
                            # the shown result instead of narrating the
                            # same "Let me check..." line twice in a row.
                            previous["tool_call"]["result_summary"] = summary
                            continue
                        new_messages.append(
                            {
                                "role": "assistant",
                                "content": _TOOL_INTRO_TEXT.get(name, f"Calling {name}..."),
                                "tool_call": {"name": name, "args": args, "result_summary": summary},
                                # One "thinking" block covers the whole
                                # response, which may hold several tool
                                # calls -- attach it (and the tool list
                                # it led to) once, to the first, rather
                                # than repeating it per call.
                                "thinking": thinking if index == 0 else None,
                                "thinking_tools": tool_names_this_round if index == 0 else None,
                            }
                        )
                        # On failure, result_data is usually empty (the
                        # error text isn't JSON -- see _tool_error_text),
                        # so feed the model the same summary it was just
                        # shown instead of an uninformative "{}" it can't
                        # act on.
                        tool_feedback = json.dumps(result_data) if not result.is_error else summary
                        ollama_messages.append({"role": "tool", "content": tool_feedback, "tool_name": name})
    except (httpx.HTTPError, OSError, ExceptionGroup) as exc:
        # The mcp Client's own async context manager runs its session
        # under an internal task group, which (Python 3.11+) wraps
        # whatever actually failed inside it -- e.g. an httpx.ReadTimeout
        # from a single very long generation -- in an ExceptionGroup
        # rather than letting it propagate directly; a bare
        # `except httpx.HTTPError` doesn't match that wrapper (confirmed
        # live: it reached uvicorn as an unhandled 500 instead of this
        # friendly message). Unwrap to the first real exception for a
        # readable message, but still catch the group as a whole so
        # nothing here can 500 the request.
        if isinstance(exc, ExceptionGroup):
            exc = exc.exceptions[0] if exc.exceptions else exc
        new_messages.append(
            {
                "role": "assistant",
                "content": (
                    f"Local model unavailable ({exc}) -- is Ollama running and has "
                    f'"{settings.ollama_model}" been pulled?'
                ),
                "tool_call": None,
            }
        )
        return new_messages, board_changed

    new_messages.append(
        {
            "role": "assistant",
            "content": "(stopped after a few tool calls without a final answer -- try rephrasing?)",
            "tool_call": None,
        }
    )
    return new_messages, board_changed
