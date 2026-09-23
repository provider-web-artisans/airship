/**
 * Attach to a DSH host that is already running.
 *
 * The spawn path in `dsh.ts` boots `dsh --profile acp` and owns that child for
 * the turn. That cannot reach the session a person has open in the harness GUI:
 * the session store holds a `flock(2)` write lease for the process that owns it
 * (DSH's `session-persistence-jsonl/src/lease.ts`), and ACP's `session/resume`
 * refuses a session that is still active. A second process can still be another
 * another *client* of that host — its mux is multi-client by construction and readers
 * never touch the lease — so this module drives the live session through the
 * same API the GUI itself uses: the `/api` unary channel for commands, and the
 * `/api/remote.mux` WebSocket for the live event stream.
 *
 * Three consequences are visible to the user, and are the reason this is a
 * separate mode rather than a tweak to the spawn path:
 *
 * - The conversation is the session's own. What Airship renders is a projection
 *   of a transcript that also exists in the harness, and the harness keeps
 *   governing the turn: its permission preset decides what tools may run, and
 *   its own approval UI is where a person answers. Airship's `--safe` and
 *   sandbox flags do not apply on this path.
 * - No preamble is prepended. On the spawn path the system prompt rides on the
 *   first turn because ACP has no system-prompt field; here the session already
 *   carries the harness's own system prompt, so adding a second one would land
 *   a wall of instructions in the user's history as if they had typed it.
 * - The cookie is minted from the host's own credential record instead of
 *   scraped from a readiness line, because the launch token is never persisted
 *   and a host Airship did not start has no stdout to read (DSH's
 *   `client/connection/src/browser-auth.ts`).
 *
 * The wire shapes here are DSH's own, not ACP's: they were read off a live host
 * running the pinned release, and the reducer is written against those frames.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { dirtyFiles } from "@airship/git";
import type { Usage } from "@airship/protocol";
import type { AgentRunContext, AgentRunOutcome } from "../agent";
import { describeTool } from "../tool-summary";
import { isAcpWriteTool, normalizeAcpTool, pathFromAcpTool } from "./dsh-acp";
import { synthesizePatch } from "./shared";

/** Extra knobs for the attach path, carried on `DshSettings`. */
export interface DshAttachSettings {
  /** `DSH_HOME` of the host being driven. Its credential record mints the
   * cookie, so a wrong value fails before any request is sent. */
  home?: string;
  /** The session to drive. Omitted only when the caller means "whatever is
   * current" and accepts a fresh session instead. */
  sessionId?: string;
  /** Base URL of the running host, e.g. `http://127.0.0.1:19387`. */
  url: string;
}

/** The record DSH stores its browser-session signing secret in. */
const SECRET_RECORD = "client-connection/browser-session";
/** The `secret:` line inside that record; the file is machine-written, so the
 * shape is stable and a full YAML parse would be a dependency. */
const SECRET_PATTERN = /secret:\s*([A-Za-z0-9_-]{20,})/;
/** Only the scheme changes; the path and port are the host's. */
const HTTP_SCHEME = /^http/;
const CREDENTIALS_FILE = ".credentials.yaml";
/** Cookie wire version and payload version, both from DSH's `browser-auth`. */
const COOKIE_VERSION = "v1";
const COOKIE_PAYLOAD_VERSION = 1;
/**
 * The cookie is bound to one authority and expires on its own. An hour covers a
 * working session and keeps a stolen cookie from being interesting; nothing is
 * written to disk, so a shorter life would only mean re-minting.
 */
const COOKIE_TTL_MS = 60 * 60 * 1000;
const MUX_PATH = "/api/remote.mux";
/** Where a host keeps its home when nobody said: the environment a `dsh` run
 * would have read, then the documented default. */
export function attachHome(explicit?: string): string {
  return explicit ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
const FOLLOW_STREAM_ID = "airship-attach";
/**
 * A turn that never settles must not hang the job forever. Generous on purpose:
 * a long edit through a busy host is normal, a wedged one is not.
 */
const TURN_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The browser cookie DSH's own GUI would hold, built from the signing secret on
 * disk. Pure so it can be tested against DSH's format without a host.
 *
 * Returns null when the record is missing or unreadable — a host that has never
 * served a browser has no secret yet, and saying so is better than sending an
 * unsigned cookie and reporting a 401 as the cause.
 */
export function mintBrowserCookie(
  credentials: string,
  authority: string,
  now: number = Date.now()
): string | null {
  const start = credentials.indexOf(SECRET_RECORD);
  if (start === -1) {
    return null;
  }
  const match = credentials.slice(start).match(SECRET_PATTERN);
  if (!match) {
    return null;
  }
  const secret = Buffer.from(match[1], "base64url");
  const body = Buffer.from(
    JSON.stringify({
      authority,
      expiresAt: now + COOKIE_TTL_MS,
      issuedAt: now,
      version: COOKIE_PAYLOAD_VERSION,
    }),
    "utf8"
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest()
    .toString("base64url");
  const name = `dsh-auth-${createHash("sha256")
    .update(authority)
    .digest()
    .toString("base64url")}`;
  return `${name}=${COOKIE_VERSION}.${body}.${signature}`;
}

/** One frame the host pushes on a follow stream. */
interface HostFrame {
  readonly type?: string;
  readonly value?: HostFrameValue;
}

interface HostFrameValue {
  readonly event?: {
    readonly type?: string;
    readonly data?: Record<string, unknown>;
  };
  readonly frame?: {
    readonly type?: string;
    readonly chunk?: Record<string, unknown>;
  };
  readonly type?: string;
}

/** What one attached turn knows while it runs. */
export interface AttachState {
  /** The cookie's turn has been seen in the durable log, so a `turn/end` now
   * belongs to us. A busy session ends the previous turn first. */
  armed: boolean;
  /** Final text off the committed assistant message; falls back to the streamed
   * prose when the commit never arrives. */
  committed: string;
  error?: string;
  requestId: string;
  settled: boolean;
  stopReason: string | null;
  streamed: string;
  tools: Map<string, { name: string; input: unknown }>;
  usage?: Usage;
}

export function newAttachState(requestId: string): AttachState {
  return {
    armed: false,
    committed: "",
    requestId,
    settled: false,
    stopReason: null,
    streamed: "",
    tools: new Map(),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The result text of a `tool/result` event, which nests one level deep. */
function toolResult(data: Record<string, unknown>): {
  callId: string;
  isError: boolean;
  text: string;
} | null {
  const message = record(data.message);
  const source = record(message.source);
  const callId = text(source.callId);
  if (!callId) {
    return null;
  }
  let isError = false;
  const parts: string[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const part = record(block);
    if (part.type !== "tool-result") {
      continue;
    }
    isError = part.isError === true;
    for (const inner of Array.isArray(part.content) ? part.content : []) {
      const piece = record(inner);
      if (piece.type === "text") {
        parts.push(text(piece.text));
      }
    }
  }
  return { callId, isError, text: parts.join("\n") };
}

/** The text parts of a committed assistant message. */
function assistantText(data: Record<string, unknown>): string {
  const message = record(data.message);
  const parts: string[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const part = record(block);
    if (part.type === "text") {
      parts.push(text(part.text));
    }
  }
  return parts.join("");
}

function usageOf(value: unknown): Usage | undefined {
  const raw = record(value);
  if (
    typeof raw.inputTokens !== "number" &&
    typeof raw.outputTokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens:
      typeof raw.inputTokens === "number" ? raw.inputTokens : undefined,
    outputTokens:
      typeof raw.outputTokens === "number" ? raw.outputTokens : undefined,
  };
}

/**
 * Fold one host frame into the turn: prose to the timeline, tools to their rows,
 * a committed message to its final text. Mirrors `reduceAcpUpdate` so the two
 * dsh paths produce the same rows for the same work.
 */
export function reduceHostFrame(
  value: HostFrameValue,
  ctx: AgentRunContext,
  state: AttachState
): void {
  if (value.type === "assistant-stream") {
    if (value.frame) {
      reduceStreamFrame(value.frame, ctx, state);
    }
    return;
  }
  if (value.type !== "event") {
    return;
  }
  const { event } = value;
  const data = event?.data ?? {};
  switch (event?.type) {
    case "tool/call":
      reduceToolCall(data, ctx, state);
      return;
    case "tool/result":
      reduceToolResult(data, ctx, state);
      return;
    case "assistant/message":
      reduceAssistantMessage(data, ctx, state);
      return;
    case "user/message":
      // Our own prompt coming back through the log is what arms the turn: until
      // it lands, an ending turn belongs to whoever was already running.
      if (text(record(data.source).rpcId) === state.requestId) {
        state.armed = true;
      }
      return;
    case "turn/end":
      if (state.armed) {
        state.settled = true;
        state.stopReason = text(record(data.reason).kind) || "completed";
      }
      return;
    default:
      return;
  }
}

/** Token-level prose and the usage frame that rides beside it. */
function reduceStreamFrame(
  frame: NonNullable<HostFrameValue["frame"]>,
  ctx: AgentRunContext,
  state: AttachState
): void {
  if (frame.type !== "chunk") {
    return;
  }
  const chunk = frame.chunk ?? {};
  if (chunk.type === "text-delta") {
    const delta = text(chunk.text);
    if (delta) {
      const index = typeof chunk.index === "number" ? chunk.index : 0;
      ctx.recorder.blockDelta(index, "text", delta);
      ctx.events.onText?.(delta);
      state.streamed += delta;
    }
    return;
  }
  if (chunk.type === "usage") {
    state.usage = usageOf(chunk.usage) ?? state.usage;
  }
}

function reduceToolCall(
  data: Record<string, unknown>,
  ctx: AgentRunContext,
  state: AttachState
): void {
  const callId = text(data.callId);
  const name = text(data.name);
  if (!(callId && name)) {
    return;
  }
  const input = parseArguments(data.arguments);
  state.tools.set(callId, { input, name });
  // The host names its tools the way the harness does (`read`, `bash`); the
  // recorder speaks the canonical vocabulary every backend shares, and the same
  // normalizer the ACP path uses is what translates between them.
  const tool = normalizeAcpTool(callId, name, input);
  ctx.recorder.openTool(tool.id, tool.name, tool.input, null);
  const step = describeTool(tool.name, tool.input);
  if (step) {
    ctx.emitStep(step);
  }
}

function reduceToolResult(
  data: Record<string, unknown>,
  ctx: AgentRunContext,
  state: AttachState
): void {
  const result = toolResult(data);
  if (!result) {
    return;
  }
  const known = state.tools.get(result.callId);
  state.tools.delete(result.callId);
  const tool = normalizeAcpTool(
    result.callId,
    known?.name ?? "",
    known?.input ?? {},
    { isError: result.isError, text: result.text }
  );
  let { typed } = tool;
  const path = pathFromAcpTool(tool.input);
  if (path && isAcpWriteTool(known?.name ?? "")) {
    const abs = isAbsolute(path) ? path : join(ctx.input.cwd, path);
    ctx.diffs.recordAfterTheFact(abs);
    const pair = ctx.diffs.pairFor(abs);
    if (pair) {
      typed = synthesizePatch(pair.before, pair.after);
    }
  }
  ctx.recorder.closeTool(tool.id, Boolean(tool.isError), tool.content, typed);
  // A shell command can write files without an edit tool call; every dirty path
  // is offered and `finalize` drops the ones that did not move.
  if (known?.name === "bash") {
    for (const dirty of dirtyFiles(ctx.input.cwd)) {
      ctx.diffs.recordAfterTheFact(dirty);
    }
  }
}

function reduceAssistantMessage(
  data: Record<string, unknown>,
  ctx: AgentRunContext,
  state: AttachState
): void {
  const final = assistantText(data);
  if (final) {
    state.committed = final;
    ctx.recorder.commitBlock("text", final);
  }
  state.usage = usageOf(data.usage) ?? state.usage;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

/** Node's WebSocket takes an options object; the DOM types only know the
 * protocols form, hence the one cast. */
function openMuxSocket(url: string, cookie: string): WebSocket {
  const Ctor = WebSocket as unknown as new (
    address: string,
    init: { headers: Record<string, string> }
  ) => WebSocket;
  return new Ctor(url, { headers: { cookie } });
}

/** Unary call against the host's `/api` channel, in the GUI's own envelope. */
async function unary(
  base: URL,
  cookie: string,
  method: string,
  args: Record<string, unknown>,
  rpcId: string
): Promise<{ error?: string; ok: boolean; value?: unknown }> {
  let response: Response;
  try {
    response = await fetch(new URL(`/api/${method}`, base), {
      body: JSON.stringify({
        method,
        payload: { args },
        rpcId,
        type: "client-request",
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    });
  } catch (err) {
    return {
      error: `${method}: ${err instanceof Error ? err.message : err}`,
      ok: false,
    };
  }
  if (!response.ok) {
    return { error: `${method} answered HTTP ${response.status}`, ok: false };
  }
  const body = (await response.json().catch(() => null)) as {
    result?: { error?: { message?: string }; ok?: boolean; value?: unknown };
  } | null;
  const result = body?.result;
  if (!result?.ok) {
    return { error: result?.error?.message ?? `${method} failed`, ok: false };
  }
  return { ok: true, value: result.value };
}

/**
 * Run one turn against a host that is already running.
 *
 * `ctx.promptText` is sent as-is: the preamble belongs to the spawn path, where
 * the harness has no session to inherit one from.
 */
export async function runAttachedTurn(
  ctx: AgentRunContext,
  settings: DshAttachSettings
): Promise<AgentRunOutcome> {
  let base: URL;
  try {
    base = new URL(settings.url);
  } catch {
    return {
      error: `--dsh-url is not a URL: ${settings.url}`,
      sessionId: null,
    };
  }

  const home = attachHome(settings.home);
  let credentials: string;
  try {
    credentials = readFileSync(join(home, CREDENTIALS_FILE), "utf8");
  } catch (err) {
    return {
      error: `cannot read ${join(home, CREDENTIALS_FILE)}: ${
        err instanceof Error ? err.message : err
      }`,
      sessionId: settings.sessionId ?? null,
    };
  }
  const cookie = mintBrowserCookie(credentials, base.host);
  if (!cookie) {
    return {
      error: `no browser-session secret in ${join(home, CREDENTIALS_FILE)}; has this host ever served the Web UI?`,
      sessionId: settings.sessionId ?? null,
    };
  }

  const requestId = `airship-${Date.now().toString(36)}`;
  let sessionId = settings.sessionId ?? null;
  if (!sessionId) {
    const created = await unary(
      base,
      cookie,
      "session/create",
      { request: { cwd: ctx.input.cwd } },
      `${requestId}-create`
    );
    if (!created.ok) {
      return {
        error: `could not create a session: ${created.error}`,
        sessionId: null,
      };
    }
    sessionId = text(record(created.value).sessionId) || null;
    if (!sessionId) {
      return {
        error: "session/create returned no session id",
        sessionId: null,
      };
    }
  }

  const state = newAttachState(requestId);
  // `assistantStream` is what carries token-level prose; without it the overlay
  // would sit empty until the committed message landed.
  const followArgs = {
    request: {
      address: { kind: "session", sessionId },
      assistantStream: true,
      maxMessages: 1,
    },
  };

  const socket = openMuxSocket(
    new URL(MUX_PATH, base).toString().replace(HTTP_SCHEME, "ws"),
    cookie
  );

  let prompted = false;
  const prompt = async (): Promise<void> => {
    const receipt = await unary(
      base,
      cookie,
      "session/prompt",
      {
        request: {
          content: [{ text: ctx.promptText, type: "text" }],
          mode: "queue",
          requestId,
          sessionId,
        },
      },
      `${requestId}-prompt`
    );
    if (!receipt.ok) {
      state.error = receipt.error;
      state.settled = true;
    }
  };

  const settle = new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      state.error ??= `the host did not settle the turn within ${Math.round(TURN_TIMEOUT_MS / 60_000)} minutes`;
      finish();
    }, TURN_TIMEOUT_MS);

    const onAbort = (): void => {
      state.stopReason = "cancelled";
      state.settled = true;
      unary(
        base,
        cookie,
        "session/cancel",
        { request: { sessionId } },
        `${requestId}-cancel`
      )
        .catch(() => undefined)
        .finally(finish);
    };
    ctx.input.abortController?.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          endpoint: "session/follow",
          payload: { args: followArgs },
          streamId: FOLLOW_STREAM_ID,
          type: "open",
        })
      );
    });
    socket.addEventListener("error", () => {
      state.error ??= "the host's event stream could not be opened";
      finish();
    });
    socket.addEventListener("close", () => {
      if (!(state.settled || state.error)) {
        state.error = "the host's event stream closed before the turn settled";
      }
      finish();
    });
    socket.addEventListener("message", (message: MessageEvent) => {
      let frame: HostFrame;
      try {
        frame = JSON.parse(String(message.data)) as HostFrame;
      } catch {
        return;
      }
      if (frame.type !== "item" || !frame.value) {
        return;
      }
      // The prompt goes out once the stream is live, so no event of ours can
      // land before something is listening for it.
      if (!prompted && frame.value.type === "snapshot") {
        prompted = true;
        prompt().catch(() => undefined);
      }
      reduceHostFrame(frame.value, ctx, state);
      if (state.settled) {
        finish();
      }
    });
  });

  await settle;
  try {
    socket.close();
  } catch {
    // Already closed; nothing to unwind.
  }

  if (state.error) {
    return { error: state.error, sessionId, usage: state.usage };
  }
  if (state.stopReason && state.stopReason !== "completed") {
    return {
      error: `the turn ended: ${state.stopReason}`,
      sessionId,
      usage: state.usage,
    };
  }
  const prose = state.committed || state.streamed;
  if (!prose) {
    return {
      error: "the turn settled without any reply",
      sessionId,
      usage: state.usage,
    };
  }
  return { resultText: prose, sessionId, usage: state.usage };
}

/**
 * Whether an attach target answers before a turn is spent on it. Runs one
 * authenticated read, so a wrong home, a dead port and a stale cookie are told
 * apart at startup instead of at the first edit.
 */
export async function checkAttach(
  settings: DshAttachSettings
): Promise<{ ok: boolean; reason?: string }> {
  let base: URL;
  try {
    base = new URL(settings.url);
  } catch {
    return { ok: false, reason: `--dsh-url is not a URL: ${settings.url}` };
  }
  const home = attachHome(settings.home);
  let credentials: string;
  try {
    credentials = readFileSync(join(home, CREDENTIALS_FILE), "utf8");
  } catch {
    return {
      ok: false,
      reason: `cannot read ${join(home, CREDENTIALS_FILE)}`,
    };
  }
  const cookie = mintBrowserCookie(credentials, base.host);
  if (!cookie) {
    return {
      ok: false,
      reason: `no browser-session secret in ${join(home, CREDENTIALS_FILE)}`,
    };
  }
  const listed = await unary(
    base,
    cookie,
    "session/list",
    { _request: {} },
    "auth-check"
  );
  return listed.ok
    ? { ok: true }
    : {
        ok: false,
        reason: `the host at ${settings.url} refused the cookie: ${listed.error}`,
      };
}
