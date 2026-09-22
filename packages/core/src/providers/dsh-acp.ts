/**
 * The ACP vocabulary dsh speaks, and the pure translation from it into the
 * Claude-shaped tuples the shared summarizer understands. No child process, no
 * SDK connection, no recorder — which is what makes the dsh event loop testable
 * without spawning the CLI.
 *
 * The vocabulary itself, and the reason for translating into it, live in
 * `./shared`.
 */
import type { Effort, Usage } from "@airship/protocol";
import type { NormalizedTool } from "./shared";

// ---------------------------------------------------------------------------
// Wire shapes — only the fields the adapter reads
// ---------------------------------------------------------------------------

/** The text payload of a chunk or of a tool result. */
export interface AcpTextContent {
  text?: string;
  type?: string;
}

/** Prose or reasoning, one chunk at a time. Both carry `content: {type: "text"}`. */
export interface AcpChunkUpdate {
  content?: AcpTextContent;
  /** Groups the chunks of one message; reused by that message's tool calls. */
  messageId?: string;
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
}

/**
 * Context occupancy after a model call, and nothing else.
 *
 * dsh fills `used` from its own token meter (every token resident in the
 * session's context) and `size` from the model's window. The ACP surface has no
 * input/output split and no cost, so this is all the usage there is.
 */
export interface AcpUsageUpdate {
  sessionUpdate: "usage_update";
  size?: number;
  used?: number;
}

/** One part of a tool result: text, a diff, or a terminal reference. */
export interface AcpToolContent {
  content?: AcpTextContent;
  type?: string;
}

/**
 * A tool call opening or finishing.
 *
 * ACP never closes a call with a new `tool_call`: the completion arrives as a
 * `tool_call_update` carrying the same `toolCallId`, the final status and the
 * content. The title (dsh's own tool name) is on the opening update only, so the
 * reducer remembers it.
 */
export interface AcpToolUpdate {
  content?: AcpToolContent[];
  kind?: string;
  rawInput?: unknown;
  sessionUpdate: "tool_call" | "tool_call_update";
  status?: string;
  title?: string;
  toolCallId: string;
}

/** Anything else the protocol may grow. Read for nothing, never fatal. */
export type AcpUpdate =
  | AcpChunkUpdate
  | AcpToolUpdate
  | AcpUsageUpdate
  | { sessionUpdate: string };

/** ACP advertises the session's selectable options next to the session id. */
export interface AcpConfigOption {
  currentValue?: unknown;
  id?: unknown;
  options?: unknown;
}

// ---------------------------------------------------------------------------
// Config options
// ---------------------------------------------------------------------------

export interface AcpChoice {
  name?: string;
  value: string;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Every value one advertised option offers.
 *
 * dsh publishes its model list as groups (`{group, name, options: [...]}`) and
 * its reasoning levels flat; both shapes are read here so the caller never has
 * to know which option it got.
 */
export function acpChoices(option: unknown): AcpChoice[] {
  const entries = (option as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(entries)) {
    return [];
  }
  const out: AcpChoice[] = [];
  const push = (entry: unknown): void => {
    const choice = rec(entry);
    const value = str(choice.value);
    if (value !== undefined) {
      out.push({ name: str(choice.name), value });
    }
  };
  for (const entry of entries) {
    const nested = rec(entry).options;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        push(child);
      }
    } else {
      push(entry);
    }
  }
  return out;
}

/** The requested model as a `[provider, model]` pair, when it is spelled that way. */
function asPair(value: string): string[] | null {
  if (!value.startsWith("[")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((p) => typeof p === "string")
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve Airship's free-form `--model` onto one of the values dsh advertises.
 *
 * dsh does not take a model id: it takes a JSON-encoded provider/model pair
 * (`["deepseek-official","deepseek-v4-pro"]`), and it rejects anything it does
 * not advertise (`-32602 unknown model option`). Three spellings therefore
 * resolve here — the encoded value verbatim, a `provider/id` pair, or the bare
 * id matched against the advertised list by its last element.
 *
 * No match is an error rather than a fallback: running on the session default
 * while the user asked for a specific model is indistinguishable, from the
 * outside, from having asked for nothing.
 */
export function resolveModelValue(
  option: unknown,
  requested: string
): { error: string } | { value: string } {
  const wanted = requested.trim();
  const values = acpChoices(option).map((c) => c.value);
  if (values.includes(wanted) || asPair(wanted)) {
    return { value: wanted };
  }
  const slash = wanted.indexOf("/");
  if (slash > 0 && slash < wanted.length - 1) {
    return {
      value: JSON.stringify([wanted.slice(0, slash), wanted.slice(slash + 1)]),
    };
  }
  const matches = values.filter((value) => asPair(value)?.at(-1) === wanted);
  const match = matches.length === 1 ? matches.at(0) : undefined;
  if (match) {
    return { value: match };
  }
  return {
    error: values.length
      ? `No model matching \`${requested}\` is advertised by this dsh profile. Available: ${values.join(", ")}.`
      : `No model matching \`${requested}\`: this dsh session advertised no model options at all.`,
  };
}

/**
 * dsh's reasoning ladder, low to high.
 *
 * Four rungs, and the middle one is its own default: `high` is the balance, not
 * the top of the scale.
 */
const EFFORT_LADDER = ["off", "low", "high", "max"] as const;

/**
 * Where each of Airship's six effort levels belongs on that ladder.
 *
 * The two scales are not the same shape, so this is a placement rather than a
 * rename: `medium` and `high` both land on dsh's `high` default, and `xhigh` and
 * `max` both on `max`.
 */
const EFFORT_RUNG: Record<Effort, number> = {
  high: 2,
  low: 1,
  max: 3,
  medium: 2,
  minimal: 0,
  xhigh: 3,
};

function rungOf(value: string): number | null {
  const at = EFFORT_LADDER.indexOf(value as (typeof EFFORT_LADDER)[number]);
  return at === -1 ? null : at;
}

/**
 * Pick the advertised effort nearest the one asked for.
 *
 * dsh validates the value against *this model's* own effort list, so asking for
 * a rung the model lacks fails the whole turn. Choosing the nearest advertised
 * rung keeps a preference from becoming an error, and — unlike leaving the
 * default in place — never quietly runs at an effort nobody asked for. Values
 * the ladder does not know (a deployment-specific level) are left for the model
 * to have an opinion about.
 */
export function chooseEffortValue(
  option: unknown,
  effort?: Effort
): string | undefined {
  if (!effort) {
    return undefined;
  }
  const wanted = EFFORT_RUNG[effort];
  const values = acpChoices(option).map((c) => c.value);
  if (!values.length) {
    return undefined;
  }
  let best: { distance: number; value: string } | undefined;
  for (const value of values) {
    const rung = rungOf(value);
    if (rung === null) {
      continue;
    }
    const distance = Math.abs(rung - wanted);
    if (!best || distance < best.distance) {
      best = { distance, value };
    }
  }
  return best?.value;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Map dsh's context meter onto `Usage`.
 *
 * `used` is every token resident in the session's context, so calling it
 * `inputTokens` is the closest true statement the ACP surface allows — it is
 * what the model was given. There is no output count and no cost to report, and
 * inventing either would be worse than the gap.
 */
export function usageFromAcpUpdate(
  update: Pick<AcpUsageUpdate, "used">
): Usage | undefined {
  const { used } = update;
  return typeof used === "number" && used > 0
    ? { inputTokens: Math.round(used) }
    : undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** dsh's tools that write to disk, and so need a before/after pair. */
export function isAcpWriteTool(title: string): boolean {
  return (
    title === "edit" || title === "str_replace_editor" || title === "write"
  );
}

/** The path a tool call is about, or null for tools that have none. */
export function pathFromAcpTool(input: unknown): string | null {
  const record = rec(input);
  const path = str(record.file_path) ?? str(record.path);
  return path ?? null;
}

/** Concatenate the text parts of a tool result, which is what the summary reads. */
export function acpResultText(content: AcpToolContent[] | undefined): string {
  return (content ?? [])
    .map((part) => str(part?.content?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

/** The trailing exit marker dsh appends to a shell tool's result. */
const EXIT_MARKER = /\n?\[exit code: (-?\d+)\]\s*$/;

/** What dsh writes when a command printed nothing. */
const NO_OUTPUT = "(no output)";

/**
 * Split a shell result into its exit code and its output.
 *
 * ACP carries no exit status, so dsh appends `[exit code: N]` to the result text
 * and writes `(no output)` when the command printed nothing. Both are
 * scaffolding rather than output, and both have to come off here: the `⎿` line
 * is built as `exit N — <first line of stdout>`, so leaving either in would
 * print `exit 7 — [exit code: 7]` or `exit 7 — (no output)`.
 *
 * `exitCode` is null when there is no marker at all — a call that never reached
 * the shell.
 */
export function parseBashResult(text: string): {
  exitCode: number | null;
  stdout: string;
} {
  const match = EXIT_MARKER.exec(text);
  const body = (match ? text.slice(0, match.index) : text).trim();
  const code = match?.[1];
  return {
    exitCode: code === undefined ? null : Number(code),
    stdout: body === NO_OUTPUT ? "" : body,
  };
}

/** The prefix dsh puts on a failed call's result text. */
const ERROR_PREFIX = /^Error:\s*/;

/**
 * dsh's own wording for a failed call, minus the prefix the row already says.
 *
 * A failure arrives as `Error: <reason>` and the summarizer renders an error row
 * as `Error: <first line>` — so passing it through unchanged reads
 * "Error: Error: tool call aborted".
 */
function errorText(text: string): string {
  return text.replace(ERROR_PREFIX, "");
}

/**
 * Map a dsh tool onto the shared vocabulary.
 *
 * dsh's tools already speak Claude's parameter names (`file_path`, `command`,
 * `old_string`), so this is a whitelist rather than a rename: the fields the
 * summarizer reads are carried over and anything else is left behind.
 */
export function normalizeAcpTool(
  toolCallId: string,
  title: string,
  rawInput: unknown,
  done?: { isError: boolean; text: string }
): NormalizedTool {
  const a = rec(rawInput);
  // The summarizer's error row adds its own `Error: ` prefix, so dsh's is taken
  // off once, before any branch reads the text.
  let text = "";
  if (done) {
    text = done.isError ? errorText(done.text) : done.text;
  }
  const base = (name: string, input: unknown): NormalizedTool => ({
    id: toolCallId,
    input,
    name,
    ...(done ? { content: text, isError: done.isError } : {}),
  });

  switch (title) {
    case "read":
      return base("Read", {
        file_path: a.file_path,
        limit: a.limit,
        offset: a.offset,
      });
    case "write":
      return base("Write", { content: a.content, file_path: a.file_path });
    case "edit":
    case "str_replace_editor":
      return base("Edit", {
        file_path: a.file_path,
        new_string: a.new_string,
        old_string: a.old_string,
        replace_all: a.replace_all,
      });
    case "bash": {
      const tool = base("Bash", {
        command: a.command,
        description: a.description,
      });
      if (done) {
        const { exitCode, stdout } = parseBashResult(text);
        tool.content = stdout;
        // A non-zero exit is information rather than a broken tool, so the row
        // keeps the code and the output. A call that failed *without* an exit
        // code never reached the shell — an abort, or a sandbox refusal — and
        // that is a real failure worth rendering as one.
        tool.isError = done.isError && exitCode === null;
        tool.typed = { exitCode: exitCode ?? (done.isError ? 1 : 0), stdout };
      }
      return tool;
    }
    case "grep":
      return base("Grep", { glob: a.glob, path: a.path, pattern: a.pattern });
    case "glob":
      return base("Glob", { path: a.path, pattern: a.pattern });
    case "todo_write":
      return base("TodoWrite", a);
    case "web_fetch":
      return base("WebFetch", { url: a.url });
    case "web_search":
      return base("WebSearch", { query: a.query });
    default:
      return base(title, a);
  }
}
