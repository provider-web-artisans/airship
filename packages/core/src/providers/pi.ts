/**
 * The pi backend.
 *
 * pi (`@earendil-works/pi-coding-agent`) is a small, unopinionated coding
 * agent with a headless RPC mode: `pi --mode rpc` speaks JSON lines over
 * stdin/stdout, and every provider that speaks an OpenAI-, Anthropic- or
 * Google-shaped API can be wired in through `~/.pi/agent/models.json`. That is
 * what makes it the natural backend for a self-hosted or dedicated model — a
 * vLLM endpoint, a RunPod worker, a local Ollama — without a gateway in front.
 *
 * What it gives, and is used for here:
 * - Token-level streaming of prose and reasoning.
 * - Tool start/end events with the call id, so rows open and close honestly.
 * - Sessions on disk, so resume and fork are native (`--session`, `--fork`).
 * - A real `--system-prompt`, so the preamble need not ride on the turn.
 * - Cumulative usage with cost when the model catalogue prices it.
 *
 * What it cannot do, handled explicitly rather than faked:
 * - No pre-tool hook, so `before` content is reconstructed from git
 *   (`needsGitBaseline`), as on Codex and OpenCode.
 * - No structured-output mode, so the payload rides in the text inside
 *   `<structuredoutput>` tags — the OpenCode convention — and is lifted out
 *   here while it streams.
 * - No sandbox and no permission channel. `--safe` narrows the toolset to the
 *   file and shell tools; it does not screen what they do.
 * - No `maxTurns`, no budget cap.
 * - No bundled binary: `pi` is a separate install, found on PATH or named by
 *   `--pi-path`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { dirtyFiles } from "@airship/git";
import type { EditStructuredOutput, Usage } from "@airship/protocol";
import {
  type AgentAdapter,
  type AgentRunContext,
  type AgentRunOutcome,
  failureText,
} from "../agent";
import { systemPrompt } from "../prompt";
import { describeTool } from "../tool-summary";
import { STRUCTURED_OPENERS, splitStructured } from "./opencode-events";
import { parseStructured } from "./opencode-reduce";
import {
  isPiWriteTool,
  normalizePiTool,
  type PiAssistantMessage,
  type PiDelta,
  type PiEvent,
  type PiUsage,
  pathFromPiTool,
  toPiThinking,
} from "./pi-events";
import { synthesizePatch } from "./shared";

/** Per-turn knobs the CLI hands through untouched. */
export interface PiSettings {
  /**
   * `PI_CODING_AGENT_DIR` for the child: a config directory holding its own
   * `models.json` / `settings.json`, so a team can ship one pi setup without
   * touching the user's own `~/.pi/agent`.
   */
  agentDir?: string;
  /** Override the binary (`pi` on PATH by default). */
  piPath?: string;
}

const WHITESPACE = /\s/;

/** How long to wait for `abort` to settle before killing the child. */
const ABORT_GRACE_MS = 2000;
/** How long the child gets to exit after the run settled. */
const EXIT_GRACE_MS = 1500;

// ---------------------------------------------------------------------------
// Reducer state
// ---------------------------------------------------------------------------

type BlockKind = "text" | "thinking";

interface BlockState {
  emitted: number;
  index: number;
  kind: BlockKind;
  raw: string;
}

export interface PiReduceState {
  /** Streamed blocks of the message in flight, keyed by `contentIndex`. */
  blocks: Map<number, BlockState>;
  error?: string;
  /** Prose from the latest assistant text, used when there is no JSON. */
  lastProse: string;
  nextBlockIndex: number;
  openedTools: Set<string>;
  /** The `<structuredoutput>` payload, lifted out of the text it rode in on. */
  payload: string | null;
  /** The prompt was accepted and the agent has since settled. */
  settled: boolean;
  usage?: Usage;
}

export function newPiState(): PiReduceState {
  return {
    blocks: new Map(),
    lastProse: "",
    nextBlockIndex: 0,
    openedTools: new Set(),
    payload: null,
    settled: false,
  };
}

export interface PiReduceHooks {
  /** Re-scan for writes made by shell commands rather than edit tools. */
  rescanDirty?: () => Set<string>;
}

// ---------------------------------------------------------------------------
// Prose, with the structured payload held back
// ---------------------------------------------------------------------------

/**
 * How much of a trailing partial `<structuredoutput>` opener to hold back, so
 * a fragment of the tag is never drawn before it can be recognised. Same rule
 * as the OpenCode reducer, restated here because that one is private to it.
 */
function withheldTail(text: string): number {
  let end = text.length;
  const longest = Math.max(...STRUCTURED_OPENERS.map((o) => o.length));
  const max = Math.min(longest - 1, end);
  outer: for (let n = max; n > 0; n -= 1) {
    const suffix = text.slice(end - n);
    for (const opener of STRUCTURED_OPENERS) {
      if (opener.startsWith(suffix)) {
        end -= n;
        break outer;
      }
    }
  }
  while (end > 0 && WHITESPACE.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  return text.length - end;
}

function visibleProse(
  state: PiReduceState,
  text: string,
  final: boolean
): string {
  const { payload, prose } = splitStructured(text);
  if (payload === null) {
    return final ? text : text.slice(0, text.length - withheldTail(text));
  }
  if (parseStructured(payload)) {
    state.payload = payload;
    return prose.trimEnd();
  }
  return final ? text : prose.trimEnd();
}

function blockFor(
  state: PiReduceState,
  contentIndex: number,
  kind: BlockKind,
  ctx: AgentRunContext
): BlockState {
  const existing = state.blocks.get(contentIndex);
  if (existing) {
    return existing;
  }
  const block: BlockState = {
    emitted: 0,
    index: state.nextBlockIndex,
    kind,
    raw: "",
  };
  state.nextBlockIndex += 1;
  state.blocks.set(contentIndex, block);
  ctx.recorder.openBlock(block.index, kind);
  return block;
}

function render(
  state: PiReduceState,
  block: BlockState,
  final: boolean,
  ctx: AgentRunContext
): void {
  let visible: string;
  if (block.kind === "thinking") {
    visible = block.raw;
  } else {
    visible = visibleProse(state, block.raw, final);
    state.lastProse = visible;
  }
  if (visible.length <= block.emitted) {
    return;
  }
  const chunk = visible.slice(block.emitted);
  block.emitted = visible.length;
  ctx.recorder.blockDelta(block.index, block.kind, chunk);
  if (block.kind === "text") {
    ctx.events.onText?.(chunk);
  }
}

function reduceDelta(
  delta: PiDelta,
  state: PiReduceState,
  ctx: AgentRunContext
): void {
  switch (delta.type) {
    case "text_start":
      blockFor(state, delta.contentIndex, "text", ctx);
      return;
    case "thinking_start":
      blockFor(state, delta.contentIndex, "thinking", ctx);
      ctx.emitStep("Thinking");
      return;
    case "text_delta":
    case "thinking_delta": {
      const kind = delta.type === "text_delta" ? "text" : "thinking";
      const block = blockFor(state, delta.contentIndex, kind, ctx);
      block.raw += delta.delta;
      render(state, block, false, ctx);
      return;
    }
    case "text_end":
    case "thinking_end": {
      const kind = delta.type === "text_end" ? "text" : "thinking";
      const block = blockFor(state, delta.contentIndex, kind, ctx);
      // The end event carries the authoritative text; deltas only ran ahead.
      if (typeof delta.content === "string") {
        block.raw = delta.content;
      }
      render(state, block, true, ctx);
      ctx.recorder.closeBlock(block.index);
      return;
    }
    default:
      // Tool-call argument streaming is not rendered: the row opens on
      // `tool_execution_start`, which carries the complete arguments.
      return;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function openTool(
  event: Extract<PiEvent, { type: "tool_execution_start" }>,
  state: PiReduceState,
  ctx: AgentRunContext
): void {
  if (state.openedTools.has(event.toolCallId)) {
    return;
  }
  state.openedTools.add(event.toolCallId);
  const tool = normalizePiTool(event.toolCallId, event.toolName, event.args);
  ctx.recorder.openTool(tool.id, tool.name, tool.input, null);
  const step = describeTool(tool.name, tool.input);
  if (step) {
    ctx.emitStep(step);
  }
}

function closeTool(
  event: Extract<PiEvent, { type: "tool_execution_end" }>,
  state: PiReduceState,
  ctx: AgentRunContext,
  hooks: PiReduceHooks
): void {
  const args = ctx.recorder.lookup(event.toolCallId)?.input as
    | Record<string, unknown>
    | undefined;
  // pi's end event names the tool but not its arguments; the recorder kept
  // them from the start event, which is why the row can still name the path.
  const rawArgs = piArgsFromNormalized(event.toolName, args);
  if (!state.openedTools.has(event.toolCallId)) {
    state.openedTools.add(event.toolCallId);
    const opened = normalizePiTool(event.toolCallId, event.toolName, rawArgs);
    ctx.recorder.openTool(opened.id, opened.name, opened.input, null);
  }
  const tool = normalizePiTool(event.toolCallId, event.toolName, rawArgs, {
    isError: Boolean(event.isError),
    result: event.result,
  });

  let { typed } = tool;
  const path = pathFromPiTool(event.toolName, rawArgs);
  if (path && isPiWriteTool(event.toolName)) {
    const abs = isAbsolute(path) ? path : join(ctx.input.cwd, path);
    ctx.diffs.recordAfterTheFact(abs);
    const pair = ctx.diffs.pairFor(abs);
    if (pair) {
      typed = synthesizePatch(pair.before, pair.after);
    }
  }
  ctx.recorder.closeTool(tool.id, Boolean(tool.isError), tool.content, typed);

  // A shell command can write files without an edit tool call; `sed -i` and
  // codemods both do. Every dirty path is offered — the baseline is recorded
  // once and `finalize` drops files whose content did not move.
  if (event.toolName === "bash" && hooks.rescanDirty) {
    for (const dirty of hooks.rescanDirty()) {
      ctx.diffs.recordAfterTheFact(dirty);
    }
  }
}

/** Undo the field renaming `normalizePiTool` did, for the end event. */
function piArgsFromNormalized(
  toolName: string,
  input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!input) {
    return;
  }
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return { ...input, path: input.file_path };
    default:
      return input;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function toUsage(usage: PiUsage | undefined): Usage | undefined {
  if (!usage) {
    return;
  }
  const cost = usage.cost?.total;
  return {
    costUsd: typeof cost === "number" && cost > 0 ? cost : undefined,
    inputTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0),
    outputTokens: usage.output,
  };
}

function isAssistant(message: unknown): message is PiAssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: string }).role === "assistant"
  );
}

/** One event, applied. Synchronous by design — this is the unit under test. */
export function reducePiEvent(
  event: PiEvent,
  ctx: AgentRunContext,
  state: PiReduceState,
  hooks: PiReduceHooks = {}
): void {
  switch (event.type) {
    case "message_start":
      // Every assistant message streams its own content indices from 0.
      state.blocks = new Map();
      return;
    case "message_update": {
      const e = event as Extract<PiEvent, { type: "message_update" }>;
      if (e.usage) {
        state.usage = toUsage(e.usage) ?? state.usage;
      }
      reduceDelta(e.assistantMessageEvent, state, ctx);
      return;
    }
    case "message_end": {
      const e = event as Extract<PiEvent, { type: "message_end" }>;
      if (!isAssistant(e.message)) {
        return;
      }
      // Flush anything a missing `text_end` left behind.
      for (const block of state.blocks.values()) {
        render(state, block, true, ctx);
        ctx.recorder.closeBlock(block.index);
      }
      state.blocks = new Map();
      if (e.message.usage) {
        state.usage = toUsage(e.message.usage) ?? state.usage;
      }
      if (e.message.stopReason === "error") {
        state.error ??= e.message.errorMessage ?? "model request failed";
      }
      return;
    }
    case "tool_execution_start":
      openTool(
        event as Extract<PiEvent, { type: "tool_execution_start" }>,
        state,
        ctx
      );
      return;
    case "tool_execution_end":
      closeTool(
        event as Extract<PiEvent, { type: "tool_execution_end" }>,
        state,
        ctx,
        hooks
      );
      return;
    case "extension_error": {
      const e = event as Extract<PiEvent, { type: "extension_error" }>;
      const id = `pi-ext-${state.nextBlockIndex}`;
      ctx.recorder.openTool(id, "Warning", {}, null);
      ctx.recorder.closeTool(
        id,
        true,
        e.error ?? e.message ?? "extension error"
      );
      return;
    }
    case "agent_settled":
      state.settled = true;
      return;
    case "response": {
      const e = event as Extract<PiEvent, { type: "response" }>;
      if (e.command === "prompt" && !e.success) {
        state.error ??= e.error ?? "pi rejected the prompt";
        state.settled = true;
      }
      return;
    }
    default:
      return;
  }
}

/** Resolve the buffered text into the outcome's `structured` / `resultText`. */
export function finishPiRun(state: PiReduceState): {
  resultText: string;
  structured: EditStructuredOutput | null;
} {
  const structured = parseStructured(state.payload);
  return { resultText: state.lastProse.trim(), structured };
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/** Where the binary is: `--pi-path`, else the first `pi` on PATH. */
export function resolvePiBinary(piPath?: string): string | null {
  if (piPath) {
    return existsSync(piPath) ? piPath : null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of ["pi", "pi.cmd", "pi.exe"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** The command line for one turn. Exported so the flag layout is testable. */
export function piArgs(ctx: AgentRunContext, includeSession = true): string[] {
  const { input } = ctx;
  const args = [
    "--mode",
    "rpc",
    // The run is Airship's: no user extensions, skills, templates or themes
    // get to alter it. `--pi-agent-dir` is the sanctioned way to ship config.
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--system-prompt",
    systemPrompt("pi"),
  ];
  if (input.model) {
    args.push("--model", input.model);
  }
  const thinking = toPiThinking(input.effort);
  if (thinking) {
    args.push("--thinking", thinking);
  }
  if (input.safe) {
    // No web tools exist to cut, and there is no sandbox; this keeps the run
    // to pi's file and shell tools so a custom tool cannot slip in.
    args.push("--tools", "read,bash,edit,write,grep,find,ls");
  }
  if (includeSession && input.resumeSessionId) {
    args.push(input.fork ? "--fork" : "--session", input.resumeSessionId);
  }
  return args;
}

/** Split a byte stream into JSON lines on LF only — see pi's framing rules. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      let line = buffer.slice(0, at);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      buffer = buffer.slice(at + 1);
      if (line.trim()) {
        onLine(line);
      }
      at = buffer.indexOf("\n");
    }
  };
}

/** What one child process run reports back, before the outcome is assembled. */
interface Attempt {
  aborted: boolean;
  sessionId: string | null;
  state: PiReduceState;
  stderr: string;
}

/**
 * Spawn `pi --mode rpc`, send the prompt, drain events until the agent settles.
 *
 * `sessionArgs` is the resume/fork pair (or nothing), kept apart from
 * `piArgs` so the resume fallback can retry with it removed.
 */
async function attempt(
  ctx: AgentRunContext,
  binary: string,
  sessionArgs: string[],
  message: string
): Promise<Attempt> {
  const { input } = ctx;
  const env = { ...process.env };
  if (input.pi?.agentDir) {
    env.PI_CODING_AGENT_DIR = input.pi.agentDir;
  }
  const child = spawn(binary, [...piArgs(ctx, false), ...sessionArgs], {
    cwd: input.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = newPiState();
  const hooks: PiReduceHooks = { rescanDirty: () => dirtyFiles(input.cwd) };
  let sessionId: string | null = null;
  let stderr = "";
  let exited = false;

  const send = (command: Record<string, unknown>): void => {
    if (!exited && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  };

  const settled = new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    child.stdout.on(
      "data",
      lineSplitter((line) => {
        let event: PiEvent;
        try {
          event = JSON.parse(line) as PiEvent;
        } catch {
          return;
        }
        if (event.type === "response") {
          const res = event as Extract<PiEvent, { type: "response" }>;
          if (res.command === "get_state" && res.success) {
            const id = (res.data as { sessionId?: string } | undefined)
              ?.sessionId;
            if (id) {
              sessionId = id;
              ctx.events.onSessionId?.(id);
            }
          }
        }
        reducePiEvent(event, ctx, state, hooks);
        if (state.settled) {
          finish();
        }
      })
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("exit", () => {
      exited = true;
      finish();
    });
    child.on("error", (err) => {
      state.error ??= err.message;
      exited = true;
      finish();
    });
  });

  const onAbort = (): void => {
    send({ type: "abort" });
    setTimeout(() => {
      if (!exited) {
        child.kill("SIGTERM");
      }
    }, ABORT_GRACE_MS).unref?.();
  };
  input.abortController?.signal.addEventListener("abort", onAbort, {
    once: true,
  });

  try {
    // The session id first, so the job can be filed even if the turn dies.
    send({ id: "state", type: "get_state" });
    send({
      id: "edit",
      images: input.images?.map((img) => ({
        data: img.dataBase64,
        mimeType: img.mediaType,
        type: "image",
      })),
      message,
      type: "prompt",
    });
    await settled;
  } finally {
    input.abortController?.signal.removeEventListener("abort", onAbort);
    if (!exited) {
      child.stdin.end();
      setTimeout(() => {
        if (!exited) {
          child.kill("SIGTERM");
        }
      }, EXIT_GRACE_MS).unref?.();
    }
  }

  return {
    aborted: Boolean(input.abortController?.signal.aborted),
    sessionId,
    state,
    stderr,
  };
}

const FRESH_ATTEMPT_NOTE =
  "This is a fresh attempt at the following; the prior conversation is not available.";

/** pi's own wording when `--session`/`--fork` names a session it cannot find. */
const NO_SESSION = /No session found/i;

async function run(ctx: AgentRunContext): Promise<AgentRunOutcome> {
  const { input } = ctx;
  const binary = resolvePiBinary(input.pi?.piPath);
  if (!binary) {
    return { error: checkAuth(input.pi).reason, sessionId: null };
  }

  const resuming = Boolean(input.resumeSessionId);
  const sessionArgs = input.resumeSessionId
    ? [input.fork ? "--fork" : "--session", input.resumeSessionId]
    : [];
  const message = input.fork
    ? `${FRESH_ATTEMPT_NOTE}\n\n---\n\n${ctx.promptText}`
    : ctx.promptText;

  let result = await attempt(ctx, binary, sessionArgs, message);

  // A session that never reached disk — the turn that minted it failed before
  // pi persisted anything — cannot be resumed. Starting over is the honest
  // reading of "continue", and better than turning a follow-up into an error;
  // the model is told, so it does not pretend to remember.
  if (
    resuming &&
    !result.aborted &&
    !result.state.settled &&
    NO_SESSION.test(result.stderr)
  ) {
    result = await attempt(
      ctx,
      binary,
      [],
      `${FRESH_ATTEMPT_NOTE}\n\n---\n\n${ctx.promptText}`
    );
  }

  const { state, stderr } = result;
  const sessionId =
    result.sessionId ?? (input.fork ? null : (input.resumeSessionId ?? null));

  if (result.aborted) {
    return {
      error: failureText(new Error("cancelled"), input.abortController),
      sessionId,
    };
  }
  if (!(state.settled || state.error)) {
    const last = stderr.trim().split("\n").at(-1);
    state.error = last
      ? `pi exited before the turn settled: ${last}`
      : "pi exited before the turn settled";
  }

  const { resultText, structured } = finishPiRun(state);
  return {
    error: state.error,
    resultText,
    sessionId,
    structured,
    usage: state.usage,
  };
}

export function checkAuth(settings?: PiSettings): {
  ok: boolean;
  reason?: string;
} {
  if (resolvePiBinary(settings?.piPath)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "No `pi` binary found on PATH. Install it with `npm i -g @earendil-works/pi-coding-agent`, or point --pi-path at it.",
  };
}

export const piAdapter: AgentAdapter = {
  checkAuth: () => checkAuth(),
  kind: "pi",
  needsGitBaseline: true,
  run,
};
