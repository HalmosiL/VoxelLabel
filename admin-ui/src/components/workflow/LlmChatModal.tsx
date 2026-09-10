import { FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { describeApiError } from "../../api/client";
import { LlmChatMessage, sendLlmChatMessage, WorkflowCard } from "../../api/workflowApi";

/** The Clinical Trial module's chat session -- a real small local model
 * (served by Ollama) driven through a real MCP server's tools (see the
 * backend's llm_client/run_llm_turn). A full-page overlay rather than a
 * small dialog: a chat session is the main thing you're doing here, not
 * a quick aside on top of the board. Each assistant turn can carry a
 * `thinking` block (the model's own reasoning trace, when the
 * underlying model supports it) shown collapsed above the reply, and a
 * `tool_call` block shown below it -- styled after how Claude Code's own
 * transcript renders a tool use. */
// The one line under the session title that varies by card role --
// everything else about the modal (message list, tool-call rendering,
// thinking blocks) is identical across all three.
const CHAT_INTRO: Record<string, string> = {
  llm: "Connects via MCP to whatever's wired into this card's input.",
  builder: "Scoped to the whole study -- helps plan and construct the eligibility pipeline on the board.",
  criterion: "Connects via MCP to whatever's wired into this card's input, and judges each case against its stored criterion.",
};
const EMPTY_STATE_HINT: Record<string, string> = {
  llm: 'No messages yet -- say hello, or ask it to "create a dataset".',
  builder: 'No messages yet -- try "help me set up an eligibility pipeline starting from all cases".',
  criterion: 'No messages yet -- try "look at the connected cases and evaluate this criterion".',
};

export default function LlmChatModal({
  card,
  onClose,
  onBoardChanged,
}: {
  card: WorkflowCard;
  onClose: () => void;
  onBoardChanged: () => void;
}) {
  const [messages, setMessages] = useState<LlmChatMessage[]>(
    (card.config.messages as LlmChatMessage[] | undefined) ?? []
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Escape closes the session (same as the × button) -- a full-page
  // overlay with no keyboard way out traps keyboard users.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A local model over MCP takes 10-60 s per turn -- a live counter next
  // to the thinking indicator makes the wait feel deliberate, not stuck.
  useEffect(() => {
    if (sentAt === null) return;
    const handle = window.setInterval(() => setElapsed(Math.round((Date.now() - sentAt) / 1000)), 1000);
    return () => window.clearInterval(handle);
  }, [sentAt]);

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    setSending(true);
    setSentAt(Date.now());
    setElapsed(0);
    setError(null);
    // Optimistic: the sent message shows up immediately, not only once
    // the model has answered -- otherwise the transcript sat on "No
    // messages yet" for the whole (long) turn.
    setMessages((prev) => [...prev, { role: "user", content: message } as LlmChatMessage]);
    setInput("");
    try {
      const result = await sendLlmChatMessage(card.id, message);
      setMessages((result.config.messages as LlmChatMessage[] | undefined) ?? []);
      if (result.board_changed) onBoardChanged();
    } catch (err) {
      setError(describeApiError(err));
      // Put the text back so it can be retried without retyping.
      setMessages((prev) => prev.slice(0, -1));
      setInput(message);
    } finally {
      setSending(false);
      setSentAt(null);
      inputRef.current?.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-white" role="dialog" aria-modal="true" aria-label={`Session -- ${card.title}`}>
      <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-100 px-6 py-4">
        <div>
          <p className="section-title">Session -- {card.title}</p>
          <p className="hint">{CHAT_INTRO[card.type] ?? CHAT_INTRO.llm}</p>
        </div>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          aria-label="Close"
          title="Close (Esc)"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </header>

      {error && (
        <div className="flex-shrink-0 px-6 pt-4">
          <p className="alert-error">{error}</p>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {messages.length === 0 && !sending && <p className="hint">{EMPTY_STATE_HINT[card.type] ?? EMPTY_STATE_HINT.llm}</p>}
          {messages.map((message, index) => (
            <ChatBubble key={index} message={message} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-xs text-gray-500" aria-live="polite">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
              </span>
              Thinking and calling tools… {elapsed > 0 && `${elapsed}s`}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleSend} className="flex-shrink-0 border-t border-gray-100 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <label className="field flex-1">
            <span className="label">Message</span>
            <input
              ref={inputRef}
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={sending ? "Waiting for the model…" : "Ask about the connected cases, or tell it what to build…"}
              disabled={sending}
              autoFocus
            />
          </label>
          <button type="submit" className="btn-primary btn-sm" disabled={sending || !input.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

function ChatBubble({ message }: { message: LlmChatMessage }) {
  if (message.role === "system") {
    return <p className="hint italic">{message.content}</p>;
  }

  const mine = message.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
      {message.thinking && <ThinkingBlock text={message.thinking} tools={message.thinking_tools} />}
      <div
        className={
          mine
            ? "max-w-[85%] rounded-lg bg-brand-600 px-3 py-1.5 text-xs text-white"
            : "max-w-[85%] whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-800"
        }
      >
        {message.content}
      </div>
      {message.tool_call && <ToolCallBlock toolCall={message.tool_call} />}
    </div>
  );
}

/** Collapsed by default -- a reasoning trace is there to inspect, not to
 * read as part of the normal back-and-forth every time. The tool(s) that
 * reasoning led to (if any) show right on the toggle itself, so what it
 * resulted in is clear without expanding it. */
function ThinkingBlock({ text, tools }: { text: string; tools?: string[] | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full max-w-[85%] rounded-lg border border-dashed border-gray-200 bg-gray-50/60 px-3 py-2 text-[11px] text-gray-500">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 font-semibold text-gray-500 hover:text-gray-700"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        Thinking
        {tools && tools.length > 0 && (
          <span className="font-normal text-gray-400">
            {" "}
            -- used {tools.map((t) => `🔧 ${t}`).join(", ")}
          </span>
        )}
      </button>
      {open && <p className="mt-1.5 whitespace-pre-wrap italic">{text}</p>}
    </div>
  );
}

function ToolCallBlock({ toolCall }: { toolCall: NonNullable<LlmChatMessage["tool_call"]> }) {
  return (
    <div className="w-full max-w-[85%] rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[11px] text-gray-600">
      <p className="font-semibold text-gray-700">🔧 {toolCall.name}</p>
      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(toolCall.args, null, 2)}</pre>
      <p className="mt-1 text-emerald-600">✓ {toolCall.result_summary}</p>
    </div>
  );
}
