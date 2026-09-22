/**
 * Pure translation from pi's RPC vocabulary into the Claude-shaped tuples the
 * shared summarizer understands. No I/O, no child process, no recorder — which
 * is what makes the pi event loop testable without spawning the CLI.
 *
 * The vocabulary itself, and the reason for translating into it, live in
 * `./shared`.
 */
import type { Effort } from "@airship/protocol";
import type { NormalizedTool } from "./shared";

/**
 * pi's thinking levels are a superset of Airship's effort scale, so nothing
 * needs clamping. `undefined` leaves pi's own default (its `--thinking`
 * setting, or the model's) in charge.
 */
export function toPiThinking(
  effort?: Effort
): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return effort;
}

// ---------------------------------------------------------------------------
// RPC wire shapes — only the fields the adapter reads
// ---------------------------------------------------------------------------

export interface PiUsage {
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  input?: number;
  output?: number;
}

export interface PiTextContent {
  text: string;
  type: "text";
}

export interface PiThinkingContent {
  thinking: string;
  type: "thinking";
}

export interface PiToolCall {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
  type: "toolCall";
}

export interface PiAssistantMessage {
  content: Array<PiTextContent | PiThinkingContent | PiToolCall>;
  errorMessage?: string;
  role: "assistant";
  stopReason:
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | "deferred";
  usage?: PiUsage;
}

/** The `assistantMessageEvent` inside a `message_update`. */
export type PiDelta =
  | { contentIndex: number; type: "text_start" }
  | { contentIndex: number; delta: string; type: "text_delta" }
  | { content?: string; contentIndex: number; type: "text_end" }
  | { contentIndex: number; type: "thinking_start" }
  | { contentIndex: number; delta: string; type: "thinking_delta" }
  | { content?: string; contentIndex: number; type: "thinking_end" }
  | {
      contentIndex: number;
      id: string;
      toolName: string;
      type: "toolcall_start";
    }
  | { contentIndex: number; delta: string; type: "toolcall_delta" }
  | { contentIndex: number; toolCall: PiToolCall; type: "toolcall_end" };

export interface PiToolResult {
  content?: Array<{ text?: string; type: string }>;
  details?: unknown;
}

/** Every stdout line pi emits in RPC mode, as much of it as the adapter reads. */
export type PiEvent =
  | { type: "agent_start" }
  | { messages?: unknown[]; type: "agent_end"; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { message?: PiAssistantMessage; type: "turn_end" }
  | { message?: { role: string }; type: "message_start" }
  | { assistantMessageEvent: PiDelta; type: "message_update"; usage?: PiUsage }
  | { message?: PiAssistantMessage | { role: string }; type: "message_end" }
  | {
      args: Record<string, unknown>;
      toolCallId: string;
      toolName: string;
      type: "tool_execution_start";
    }
  | {
      args?: Record<string, unknown>;
      toolCallId: string;
      toolName: string;
      type: "tool_execution_update";
    }
  | {
      isError?: boolean;
      result?: PiToolResult;
      toolCallId: string;
      toolName: string;
      type: "tool_execution_end";
    }
  | { error?: string; message?: string; type: "extension_error" }
  | {
      command?: string;
      data?: unknown;
      error?: string;
      id?: string;
      success: boolean;
      type: "response";
    }
  | { type: string };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** The path a pi tool call is about, or null for tools that have none. */
export function pathFromPiTool(
  toolName: string,
  args: Record<string, unknown> | undefined
): string | null {
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return str(args?.path) ?? null;
    default:
      return null;
  }
}

/** pi's tools that write to disk, and so need a before/after pair. */
export function isPiWriteTool(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

/** Concatenate the text parts of a tool result, which is what the summary reads. */
export function piResultText(result: PiToolResult | undefined): string {
  return (result?.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
}

/**
 * Map a pi tool onto the shared vocabulary. Inputs are reshaped onto the
 * Claude field names (`file_path`, `command`, `pattern`) that `describeTool`
 * and `toolArgs` read; anything they do not read is left off.
 */
export function normalizePiTool(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  done?: { isError: boolean; result: PiToolResult | undefined }
): NormalizedTool {
  const a = args ?? {};
  const base = (name: string, input: unknown): NormalizedTool => ({
    id: toolCallId,
    input,
    name,
    ...(done
      ? { content: piResultText(done.result), isError: done.isError }
      : {}),
  });

  switch (toolName) {
    case "read":
      return base("Read", {
        file_path: a.path,
        limit: a.limit,
        offset: a.offset,
      });
    case "write":
      return base("Write", { content: a.content, file_path: a.path });
    case "edit": {
      const edits = Array.isArray(a.edits) ? a.edits : [];
      return base(edits.length > 1 ? "MultiEdit" : "Edit", {
        edits,
        file_path: a.path,
      });
    }
    case "bash": {
      const tool = base("Bash", { command: a.command });
      if (done) {
        // pi reports a failed command as an error result. As on Codex, a
        // non-zero exit is information rather than a broken tool, so the row
        // keeps the output instead of collapsing to "Error: …".
        tool.isError = false;
        tool.typed = { exitCode: done.isError ? 1 : 0, stdout: tool.content };
      }
      return tool;
    }
    case "grep":
      return base("Grep", { glob: a.glob, path: a.path, pattern: a.pattern });
    case "find":
      return base("Glob", { path: a.path, pattern: a.pattern });
    case "ls":
      return base("Glob", { path: a.path, pattern: a.path ?? "." });
    default:
      return base(toolName, a);
  }
}
