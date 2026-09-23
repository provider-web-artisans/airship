/**
 * The dsh backend.
 *
 * `dsh` (deepseek-harness) is a profile-driven agent runner, and `dsh --profile
 * acp` boots a coding agent that speaks ACP — the Agent Client Protocol — as
 * newline-delimited JSON-RPC over stdio. That is the surface used here, and it
 * is the only one worth using: the installed 0.1.5 CLI has no `--json` and no
 * `--session-id`, so ACP is what both it and 0.1.6 agree on.
 *
 * What it gives, and is used for here:
 * - Token-level streaming of prose and reasoning, each chunk tagged with the
 *   id of the message it belongs to.
 * - Tool start/end notifications carrying the call id and the tool's real
 *   result text, so rows open and close honestly.
 * - A real model selection and reasoning-effort control, through the options
 *   the session advertises.
 * - Sessions on disk, resumable from another process (`session/resume`).
 * - A protocol-level cancel that settles the turn instead of killing it.
 *
 * What it cannot do, handled explicitly rather than faked:
 * - No pre-tool hook, so `before` content is reconstructed from git
 *   (`needsGitBaseline`), as on pi, Codex and OpenCode.
 * - No structured-output mode, so the payload rides in the text inside
 *   `<structuredoutput>` tags — the OpenCode convention — and is lifted out
 *   here while it streams.
 * - No system-prompt option, so the preamble rides on the first turn's text and
 *   is skipped when resuming, as on Codex.
 * - No usage split and no cost: `usage_update` reports one number, the total
 *   tokens resident in the session's context, and that is what `inputTokens`
 *   carries.
 * - No image input: this install advertises `promptCapabilities.image: false`
 *   and refuses an inline image with `-32602`. The capability is read from
 *   `initialize` at runtime, and a run carrying images fails with that reason
 *   rather than dropping them.
 * - No sandbox and no permission channel. `--safe` is therefore best-effort: it
 *   exports `DSH_PERMISSION_MODE=read-only` to the child, which the child's own
 *   `$DSH_HOME/settings.yaml` can silently outrank — a `permission.defaultPreset`
 *   of `danger-full-access` wins over the variable. An isolated
 *   `--dsh-agent-dir` (exported as `DSH_HOME`) is what makes it real; Airship
 *   does not verify the outcome afterwards.
 * - No bundled binary: `dsh` is a separate install, found on PATH or named by
 *   `--dsh-path`.
 * - No leniency on the wire: the transport is the official ACP SDK, which
 *   parses every update against the protocol schema. An update it does not
 *   recognise is logged and dropped rather than passed through — the honest
 *   failure for a protocol that may still grow.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type ClientContext,
  client,
  type InitializeResponse,
  type NewSessionResponse,
  ndJsonStream,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
} from "@agentclientprotocol/sdk";
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
import {
  type AcpChunkUpdate,
  type AcpToolUpdate,
  type AcpUpdate,
  chooseEffortValue,
  isAcpWriteTool,
  normalizeAcpTool,
  pathFromAcpTool,
  resolveModelValue,
  usageFromAcpUpdate,
} from "./dsh-acp";
import { type DshAttachSettings, runAttachedTurn } from "./dsh-attach";
import { STRUCTURED_OPENERS, splitStructured } from "./opencode-events";
import { parseStructured } from "./opencode-reduce";
import { synthesizePatch } from "./shared";

/** Per-turn knobs the CLI hands through untouched. */
export interface DshSettings {
  /**
   * `DSH_HOME` for the child: the directory whose `profiles/` and
   * `settings.yaml` the launcher boots from, so a team can ship one dsh setup
   * without touching the user's own `~/.dsh`.
   */
  agentDir?: string;
  /** Override the binary (`dsh` on PATH by default). */
  dshPath?: string;
  /** `DSH_HOME` of an already-running host, whose credential record mints the
   * cookie for the attach path. Defaults to `$DSH_HOME` or `~/.dsh`. */
  home?: string;
  /** The session to drive when attaching. A fresh one is created when absent. */
  sessionId?: string;
  /** Drive the session on that host instead of spawning a child. Its absence
   * is what selects the spawn path, so this is the switch, not a hint. */
  url?: string;
}

const WHITESPACE = /\s/;

/** How long to wait for `session/cancel` to settle before killing the child. */
const ABORT_GRACE_MS = 2000;
/** How long the child gets to exit after the run settled. */
const EXIT_GRACE_MS = 1500;

/**
 * The profile that speaks ACP. Named as a constant because it is the whole
 * contract: any other profile boots an agent with no protocol on stdio.
 */
const ACP_PROFILE = "acp";

/**
 * Sent when a run carries images. Worded as the capability, because that is
 * what the agent itself would answer — and because dropping the screenshot
 * would leave the model following instructions about a picture it cannot see.
 */
const IMAGES_UNSUPPORTED =
  "The dsh backend cannot accept images: this dsh profile advertises promptCapabilities.image = false. Remove the screenshot, or run this edit on a backend that takes inline images.";

const FRESH_ATTEMPT_NOTE =
  "This is a fresh attempt at the following; the prior conversation is not available.";

/**
 * dsh's own wording when a session id it was handed cannot be resumed, and the
 * ACP spelling of the same thing.
 */
const NO_SESSION = /not resumable|unknown session/i;

// ---------------------------------------------------------------------------
// Reducer state
// ---------------------------------------------------------------------------

type BlockKind = "text" | "thinking";

interface BlockState {
  emitted: number;
  index: number;
  kind: BlockKind;
  /** The chunk's own message id, when it carried one. */
  messageId: string | null;
  raw: string;
}

interface OpenTool {
  input: unknown;
  title: string;
}

export interface AcpReduceState {
  /**
   * The run of chunks currently being written, if any. ACP has no content
   * index, so a block is a contiguous run of one kind from one message — it
   * ends when the kind changes, the message id does, or a tool call or the end
   * of the turn intervenes.
   */
  block: BlockState | null;
  closedTools: Set<string>;
  error?: string;
  /** Prose from the latest assistant text, used when there is no JSON. */
  lastProse: string;
  nextBlockIndex: number;
  openedTools: Set<string>;
  /** The `<structuredoutput>` payload, lifted out of the text it rode in on. */
  payload: string | null;
  settled: boolean;
  /** `session/prompt`'s answer: `end_turn`, `cancelled`, … */
  stopReason: string | null;
  /** Tool calls by id, so the completion can name what its opening named. */
  tools: Map<string, OpenTool>;
  usage?: Usage;
}

export function newAcpState(): AcpReduceState {
  return {
    block: null,
    closedTools: new Set(),
    lastProse: "",
    nextBlockIndex: 0,
    openedTools: new Set(),
    payload: null,
    settled: false,
    stopReason: null,
    tools: new Map(),
  };
}

export interface AcpReduceHooks {
  /** Re-scan for writes made by shell commands rather than edit tools. */
  rescanDirty?: () => Set<string>;
}

// ---------------------------------------------------------------------------
// Prose, with the structured payload held back
// ---------------------------------------------------------------------------

/**
 * How much of a trailing partial `<structuredoutput>` opener to hold back, so a
 * fragment of the tag is never drawn before it can be recognised. Same rule as
 * the pi and OpenCode reducers, restated here because both copies are private
 * to their own file.
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
  state: AcpReduceState,
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

function render(
  state: AcpReduceState,
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

/** End the run of chunks in flight, flushing anything a later event skipped. */
function closeBlock(state: AcpReduceState, ctx: AgentRunContext): void {
  const { block } = state;
  if (!block) {
    return;
  }
  render(state, block, true, ctx);
  ctx.recorder.closeBlock(block.index);
  state.block = null;
}

function blockFor(
  state: AcpReduceState,
  kind: BlockKind,
  messageId: string | null,
  ctx: AgentRunContext
): BlockState {
  const current = state.block;
  const continues =
    current !== null &&
    current.kind === kind &&
    (messageId === null ||
      current.messageId === null ||
      current.messageId === messageId);
  if (continues) {
    return current;
  }
  closeBlock(state, ctx);
  const block: BlockState = {
    emitted: 0,
    index: state.nextBlockIndex,
    kind,
    messageId,
    raw: "",
  };
  state.nextBlockIndex += 1;
  state.block = block;
  ctx.recorder.openBlock(block.index, kind);
  return block;
}

function reduceChunk(
  update: AcpChunkUpdate,
  state: AcpReduceState,
  ctx: AgentRunContext
): void {
  const text = update.content?.text;
  if (!text) {
    return;
  }
  const kind =
    update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "text";
  const block = blockFor(state, kind, update.messageId ?? null, ctx);
  if (block.raw === "" && kind === "thinking") {
    ctx.emitStep("Thinking");
  }
  block.raw += text;
  render(state, block, false, ctx);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function reduceTool(
  update: AcpToolUpdate,
  state: AcpReduceState,
  ctx: AgentRunContext,
  hooks: AcpReduceHooks
): void {
  const id = update.toolCallId;
  if (!id) {
    return;
  }
  // A tool call ends the prose before it: whatever is written after belongs to
  // a later block, and appending it here would interleave the two.
  closeBlock(state, ctx);

  const known = state.tools.get(id);
  const title = update.title ?? known?.title ?? "";
  const input = update.rawInput ?? known?.input ?? {};
  state.tools.set(id, { input, title });

  if (!state.openedTools.has(id)) {
    state.openedTools.add(id);
    const tool = normalizeAcpTool(id, title, input);
    ctx.recorder.openTool(tool.id, tool.name, tool.input, null);
    const step = describeTool(tool.name, tool.input);
    if (step) {
      ctx.emitStep(step);
    }
  }

  // `in_progress` and `pending` only open the row; the completed/failed update
  // is what closes it, and it never repeats.
  if (update.status !== "completed" && update.status !== "failed") {
    return;
  }
  if (state.closedTools.has(id)) {
    return;
  }
  state.closedTools.add(id);

  const tool = normalizeAcpTool(id, title, input, {
    isError: update.status === "failed",
    text: resultTextOf(update),
  });

  let { typed } = tool;
  const path = pathFromAcpTool(input);
  if (path && isAcpWriteTool(title)) {
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
  if (title === "bash" && hooks.rescanDirty) {
    for (const dirty of hooks.rescanDirty()) {
      ctx.diffs.recordAfterTheFact(dirty);
    }
  }
}

function resultTextOf(update: AcpToolUpdate): string {
  return (update.content ?? [])
    .map((part) => part?.content?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One update, applied. Synchronous by design — this is the unit under test. */
export function reduceAcpUpdate(
  update: AcpUpdate,
  ctx: AgentRunContext,
  state: AcpReduceState,
  hooks: AcpReduceHooks = {}
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      reduceChunk(update as AcpChunkUpdate, state, ctx);
      return;
    case "usage_update": {
      const e = update as Extract<AcpUpdate, { sessionUpdate: "usage_update" }>;
      state.usage = usageFromAcpUpdate(e) ?? state.usage;
      return;
    }
    case "tool_call":
    case "tool_call_update":
      reduceTool(update as AcpToolUpdate, state, ctx, hooks);
      return;
    default:
      // `plan`, `available_commands_update`, `current_mode_update` and whatever
      // the protocol grows next carry nothing this timeline draws. Dropped
      // rather than guessed at.
      return;
  }
}

/**
 * Close the turn, with the reason `session/prompt` gave for stopping.
 *
 * Kept apart from the per-update reducer because it is driven by the response,
 * not by a notification — and because a cancelled turn has to be reportable as
 * a cancellation rather than as a failure with whatever message unwound.
 */
export function finishAcpTurn(
  state: AcpReduceState,
  ctx: AgentRunContext,
  stopReason: string | null
): void {
  state.stopReason = stopReason;
  state.settled = true;
  closeBlock(state, ctx);
}

/** Resolve the buffered text into the outcome's `structured` / `resultText`. */
export function finishAcpRun(state: AcpReduceState): {
  resultText: string;
  structured: EditStructuredOutput | null;
} {
  const structured = parseStructured(state.payload);
  return { resultText: state.lastProse.trim(), structured };
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/** Where the binary is: `--dsh-path`, else the first `dsh` on PATH. */
export function resolveDshBinary(dshPath?: string): string | null {
  if (dshPath) {
    return existsSync(dshPath) ? dshPath : null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of ["dsh", "dsh.cmd", "dsh.exe"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** The command line for one turn. Exported so the flag layout is testable. */
export function dshArgs(): string[] {
  return ["--profile", ACP_PROFILE];
}

/**
 * Answer a permission request.
 *
 * There is nobody to ask — Airship has no permission UI — so the run keeps the
 * policy it was started with and takes the first option dsh offered that allows
 * the call. A request with nothing to allow is declined rather than parked: a
 * turn waiting on an answer that can never come hangs until the child is
 * killed, and reporting that as the model's failure would be a lie.
 */
function answerPermission(
  params: RequestPermissionRequest
): RequestPermissionResponse {
  const allow = params.options.find(
    (option) => option.kind === "allow_once" || option.kind === "allow_always"
  );
  return allow
    ? { outcome: { optionId: allow.optionId, outcome: "selected" } }
    : { outcome: { outcome: "cancelled" } };
}

/**
 * `session/set_config_option`'s own method name, typed wide on purpose.
 *
 * dsh 0.1.5 names the parameter `configId`, while the SDK's generated types
 * (ACP 1.5) call it `configOptionId`; the agent answers `-32602 Invalid params`
 * for the spelling it does not know. Outbound params are not schema-validated by
 * the SDK — only responses are mapped — so declaring the method as a plain
 * string selects the untyped overload and puts the wire name in charge.
 */
const SET_CONFIG_OPTION: string = "session/set_config_option";

/** Set one advertised session option, and let dsh be the judge of the value. */
async function setConfigOption(
  cx: ClientContext,
  sessionId: string,
  configId: string,
  value: string
): Promise<void> {
  await cx.request<unknown, Record<string, unknown>>(SET_CONFIG_OPTION, {
    configId,
    sessionId,
    value,
  });
}

/** The advertised option with this id, if the session published one. */
function optionFor(
  configOptions: unknown,
  id: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }
  return configOptions.find(
    (option): option is Record<string, unknown> =>
      typeof option === "object" &&
      option !== null &&
      (option as { id?: unknown }).id === id
  );
}

/**
 * Apply the run's model and effort to a freshly opened session.
 *
 * Both are preferences on the ACP surface rather than launch flags, and both are
 * per-session state, so they are set here instead of being passed to the child.
 * A model that cannot be resolved is an error and stops the run — see
 * `resolveModelValue`; an effort is placed on the ladder the model actually
 * advertises, so it can never fail the turn.
 */
async function applyConfigOptions(
  cx: ClientContext,
  sessionId: string,
  configOptions: unknown,
  ctx: AgentRunContext
): Promise<void> {
  const { input } = ctx;
  if (input.model) {
    const resolved = resolveModelValue(
      optionFor(configOptions, "model"),
      input.model
    );
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    await setConfigOption(cx, sessionId, "model", resolved.value);
  }
  const effort = chooseEffortValue(
    optionFor(configOptions, "reasoning_effort"),
    input.effort
  );
  if (effort) {
    await setConfigOption(cx, sessionId, "reasoning_effort", effort);
  }
}

/**
 * Open the session this turn runs in: the one named, or a brand-new one.
 *
 * `session/resume` answers with the config options only — the id is the one
 * that was asked for — while `session/new` mints it, so the id is carried out
 * of here explicitly rather than read off the response.
 */
async function openSession(
  cx: ClientContext,
  ctx: AgentRunContext,
  resumeId: string | null
): Promise<{ configOptions: unknown; sessionId: string }> {
  const { input } = ctx;
  if (resumeId) {
    const { configOptions } = await cx.request<ResumeSessionResponse>(
      "session/resume",
      { cwd: input.cwd, mcpServers: [], sessionId: resumeId }
    );
    return { configOptions, sessionId: resumeId };
  }
  const { configOptions, sessionId } = await cx.request<NewSessionResponse>(
    "session/new",
    { cwd: input.cwd, mcpServers: [] }
  );
  return { configOptions, sessionId };
}

/** What one child process run reports back, before the outcome is assembled. */
interface Attempt {
  aborted: boolean;
  sessionId: string | null;
  state: AcpReduceState;
  stderr: string;
}

/**
 * Spawn `dsh --profile acp`, open (or resume) a session, run one turn.
 *
 * `resumeId` is the session to continue, or null for a new one — kept as its
 * own parameter so the fresh-attempt fallback can retry with it removed.
 */
async function attempt(
  ctx: AgentRunContext,
  binary: string,
  resumeId: string | null,
  message: string
): Promise<Attempt> {
  const { input } = ctx;
  const state = newAcpState();
  const hooks: AcpReduceHooks = { rescanDirty: () => dirtyFiles(input.cwd) };

  const env = { ...process.env };
  if (input.dsh?.agentDir) {
    env.DSH_HOME = input.dsh.agentDir;
  }
  if (input.safe) {
    // Best-effort confinement, and only that: the child's own settings file can
    // outrank this. See the note at the top of the file.
    env.DSH_PERMISSION_MODE = "read-only";
  }

  const child = spawn(binary, dshArgs(), {
    cwd: input.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let exited = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
  });
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (err) => {
    state.error ??= err.message;
    exited = true;
  });

  let sessionId: string | null = null;
  let cx: ClientContext | null = null;

  const app = client({ name: "airship" })
    .onRequest("session/request_permission", ({ params }) =>
      answerPermission(params)
    )
    .onNotification("session/update", ({ params }) => {
      // One child, one session: anything else is not ours to draw. Guarded
      // rather than assumed, because the handler is live before the session id
      // exists.
      if (!(sessionId && params.sessionId === sessionId)) {
        return;
      }
      reduceAcpUpdate(params.update as unknown as AcpUpdate, ctx, state, hooks);
    });

  const onAbort = (): void => {
    // The protocol-level path first: dsh settles the turn with
    // `stopReason: "cancelled"` and leaves the session usable. The kill is the
    // backstop for a child that answers nothing.
    try {
      cx?.notify("session/cancel", { sessionId: sessionId ?? "" }).catch(() => {
        /* the child is about to be killed anyway */
      });
    } catch {
      // The connection is already gone. Nothing to cancel over it; the kill
      // below is the whole abort.
    }
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
    await app.connectWith(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
      async (connection) => {
        cx = connection;
        // The client side of the capability exchange: this process never
        // serves the agent's filesystem, so both fs halves are declined and the
        // agent's own tools do the reading and writing.
        const init = await connection.request<InitializeResponse>(
          "initialize",
          {
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
            protocolVersion: 1,
          }
        );
        const imagesOk =
          init.agentCapabilities?.promptCapabilities?.image === true;
        if (!imagesOk && input.images?.length) {
          throw new Error(IMAGES_UNSUPPORTED);
        }

        // `session/resume` answers with the options only — the id is the one
        // that was asked for — while `session/new` mints it.
        const { configOptions, sessionId: opened } = await openSession(
          connection,
          ctx,
          resumeId
        );
        sessionId = opened;
        ctx.events.onSessionId?.(opened);
        await applyConfigOptions(connection, opened, configOptions, ctx);

        const response = await connection.request<PromptResponse>(
          "session/prompt",
          {
            prompt: [{ text: message, type: "text" }],
            sessionId: opened,
          }
        );
        finishAcpTurn(state, ctx, response.stopReason ?? null);
      }
    );
  } catch (err) {
    state.error ??= failureText(err, input.abortController);
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

/**
 * The attach triple, when `--dsh-url` selected that path. `home` falls back to
 * the environment a spawned child would have inherited, so a person who already
 * exports `DSH_HOME` does not have to name it twice.
 */
function attachSettings(
  settings: DshSettings | undefined
): DshAttachSettings | null {
  if (!settings?.url) {
    return null;
  }
  return {
    home: settings.home,
    sessionId: settings.sessionId,
    url: settings.url,
  };
}

async function run(ctx: AgentRunContext): Promise<AgentRunOutcome> {
  const { input } = ctx;
  const attached = attachSettings(input.dsh);
  if (attached) {
    return await runAttachedTurn(ctx, attached);
  }
  const binary = resolveDshBinary(input.dsh?.dshPath);
  if (!binary) {
    return { error: checkAuth(input.dsh).reason, sessionId: null };
  }

  const resuming = Boolean(input.resumeSessionId) && !input.fork;
  const forking = Boolean(input.fork && input.resumeSessionId);
  const resumeId = resuming ? (input.resumeSessionId ?? null) : null;

  // The preamble is skipped on resume: the session history already carries it,
  // and repeating instructions the model already followed is pure noise.
  const parts: string[] = [];
  if (!resuming) {
    parts.push(systemPrompt("dsh"));
  }
  if (forking) {
    parts.push(FRESH_ATTEMPT_NOTE);
  }
  parts.push(ctx.promptText);
  const message = parts.join("\n\n---\n\n");

  let result = await attempt(ctx, binary, resumeId, message);

  // dsh cannot fork a session, and a session that was never persisted — the
  // turn that minted it failed before anything reached disk — cannot be
  // resumed. Starting over is the honest reading of "continue" in both cases,
  // and better than turning a follow-up into an error; the model is told, so it
  // does not pretend to remember.
  if (
    resuming &&
    !result.aborted &&
    result.state.error &&
    NO_SESSION.test(result.state.error)
  ) {
    result = await attempt(
      ctx,
      binary,
      null,
      `${FRESH_ATTEMPT_NOTE}\n\n---\n\n${ctx.promptText}`
    );
  }

  const { state, stderr } = result;
  const sessionId =
    result.sessionId ?? (forking ? null : (input.resumeSessionId ?? null));

  if (result.aborted || state.stopReason === "cancelled") {
    return {
      error: failureText(new Error("cancelled"), input.abortController),
      sessionId,
    };
  }
  if (!(state.settled || state.error)) {
    const last = stderr.trim().split("\n").at(-1);
    state.error = last
      ? `dsh exited before the turn settled: ${last}`
      : "dsh exited before the turn settled";
  }

  const { resultText, structured } = finishAcpRun(state);
  return {
    error: state.error,
    resultText,
    sessionId,
    structured,
    usage: state.usage,
  };
}

export function checkAuth(settings?: DshSettings): {
  ok: boolean;
  reason?: string;
} {
  if (settings?.url) {
    // The attach path spends a request on its own check (`checkAttach`), which
    // can tell a wrong home from a dead port; there is no binary to look for.
    return { ok: true };
  }
  if (resolveDshBinary(settings?.dshPath)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "No `dsh` binary found on PATH. Install it with `npm i -g @deepseek-ai/dsh`, or point --dsh-path at it.",
  };
}

export const dshAdapter: AgentAdapter = {
  checkAuth: () => checkAuth(),
  kind: "dsh",
  needsGitBaseline: true,
  run,
};
