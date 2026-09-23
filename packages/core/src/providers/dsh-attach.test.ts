/**
 * Drives the attach path's two pure halves: minting the cookie DSH's own GUI
 * would hold, and folding the host's frames into the shared timeline.
 *
 * The frames below are copied from a live host running the pinned release —
 * `read` call, its result, the committed message, the turn end — rather than
 * from documentation, because this is the translation layer and the translation
 * layer is where the risk is.
 *
 * The last block drives a real host. It is skipped unless
 * `AIRSHIP_DSH_ATTACH_URL` and `AIRSHIP_DSH_ATTACH_HOME` are set, so the suite
 * stays offline by default and an end-to-end check stays one command away:
 *
 *   AIRSHIP_DSH_ATTACH_URL=http://127.0.0.1:60917 \
 *   AIRSHIP_DSH_ATTACH_HOME=/tmp/airship-bridge/home pnpm test
 */

import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimelineItem, TimelineToolItem } from "@airship/protocol";
import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "../agent";
import { DiffCapture } from "../diff-capture";
import { TimelineRecorder } from "../timeline";
import {
  type AttachState,
  mintBrowserCookie,
  newAttachState,
  reduceHostFrame,
  runAttachedTurn,
} from "./dsh-attach";

/** A credential file shaped like DSH's, with a secret nobody can reuse. */
function credentials(secret: string): string {
  return [
    "version: 1",
    "records:",
    "  client-connection/browser-session:",
    "    kind: grant",
    "    payload:",
    "      version: 1",
    `      secret: ${secret}`,
    "refs: {}",
    "",
  ].join("\n");
}

/** A session id as the host mints it: `session-<uuid>`. */
const SESSION_ID = /^session-/;

const SECRET = Buffer.alloc(32, 7).toString("base64url");
const AUTHORITY = "127.0.0.1:19387";

function context(
  cwd: string,
  prompt = "do the thing"
): {
  ctx: AgentRunContext;
  items: TimelineItem[];
  steps: string[];
  text: string[];
} {
  const items: TimelineItem[] = [];
  const steps: string[] = [];
  const text: string[] = [];
  const recorder = new TimelineRecorder({ onItem: (item) => items.push(item) });
  const ctx = {
    diffs: new DiffCapture(cwd),
    emitStep: (step: string) => steps.push(step),
    events: { onText: (delta: string) => text.push(delta) },
    input: { cwd, prompt },
    promptText: prompt,
    recorder,
  } as unknown as AgentRunContext;
  return { ctx, items, steps, text };
}

function drive(
  frames: unknown[],
  ctx: AgentRunContext,
  state: AttachState
): void {
  for (const frame of frames) {
    reduceHostFrame(frame as never, ctx, state);
  }
}

const tools = (items: TimelineItem[]): TimelineToolItem[] =>
  items.filter((i): i is TimelineToolItem => i.kind === "tool");

describe("minting the browser cookie", () => {
  it("builds a cookie the host's own verifier would accept", () => {
    const fixed = 1_700_000_000_000;
    const cookie = mintBrowserCookie(credentials(SECRET), AUTHORITY, fixed);
    expect(cookie).not.toBeNull();

    const [name = "", value = ""] = (cookie as string).split("=");
    const [version, body = "", signature = ""] = value.split(".");
    expect(name.startsWith("dsh-auth-")).toBe(true);
    expect(version).toBe("v1");

    // The signature is over the body with DSH's own stored secret, which is the
    // whole contract: a body that verifies here verifies there.
    const expected = createHmac("sha256", Buffer.from(SECRET, "base64url"))
      .update(body)
      .digest()
      .toString("base64url");
    expect(signature).toBe(expected);

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    expect(payload).toEqual({
      authority: AUTHORITY,
      expiresAt: fixed + 60 * 60 * 1000,
      issuedAt: fixed,
      version: 1,
    });
  });

  it("declines a file that has no browser-session record", () => {
    expect(
      mintBrowserCookie("version: 1\nrecords: {}\n", AUTHORITY)
    ).toBeNull();
  });

  it("declines a record whose secret is absent", () => {
    const withoutSecret =
      "records:\n  client-connection/browser-session:\n    kind: grant\n";
    expect(mintBrowserCookie(withoutSecret, AUTHORITY)).toBeNull();
  });
});

describe("reducing the host's frames", () => {
  it("streams prose into one row and commits it in place", () => {
    const { ctx, items, text } = context(process.cwd());
    const state = newAttachState("airship-1");
    drive(
      [
        {
          frame: {
            chunk: { index: 0, text: "The name is ", type: "text-delta" },
            type: "chunk",
          },
          type: "assistant-stream",
        },
        {
          frame: {
            chunk: { index: 0, text: "probe-project.", type: "text-delta" },
            type: "chunk",
          },
          type: "assistant-stream",
        },
        {
          event: {
            data: {
              message: {
                content: [{ text: "The name is probe-project.", type: "text" }],
                role: "assistant",
              },
              turn: 1,
              usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
            },
            type: "assistant/message",
          },
          type: "event",
        },
      ],
      ctx,
      state
    );

    expect(text.join("")).toBe("The name is probe-project.");
    const prose = items.filter((i) => i.kind === "text");
    expect(prose).toHaveLength(1);
    expect(prose[0]).toMatchObject({
      streaming: false,
      text: "The name is probe-project.",
    });
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("opens and closes a tool row from the call and its result", () => {
    const { ctx, items, steps } = context(process.cwd());
    const state = newAttachState("airship-1");
    drive(
      [
        {
          event: {
            data: {
              arguments: '{"file_path": "package.json"}',
              callId: "call_00_ET_ZCTTM",
              name: "read",
              step: 1,
              turn: 1,
            },
            type: "tool/call",
          },
          type: "event",
        },
        {
          event: {
            data: {
              message: {
                content: [
                  {
                    content: [
                      { text: '{\n  "name": "probe-project"\n}', type: "text" },
                    ],
                    isError: false,
                    toolCallId: "call_00_ET_ZCTTM",
                    type: "tool-result",
                  },
                ],
                source: { callId: "call_00_ET_ZCTTM", kind: "tool" },
              },
              meta: { path: "/tmp/probe/package.json" },
              step: 1,
              turn: 1,
            },
            type: "tool/result",
          },
          type: "event",
        },
      ],
      ctx,
      state
    );

    const rows = tools(items);
    expect(rows).toHaveLength(1);
    // Canonical name, not the host's `read`: the row has to read the same here
    // as it does on every other backend.
    expect(rows[0]).toMatchObject({
      id: "call_00_ET_ZCTTM",
      name: "Read",
      phase: "ok",
    });
    expect(rows[0]?.title).toContain("package.json");
    expect(steps).toHaveLength(1);
    expect(state.tools.size).toBe(0);
  });

  it("arms on our own prompt and settles only on the turn that follows", () => {
    const { ctx } = context(process.cwd());
    const state = newAttachState("airship-mine");

    // A turn that was already running when we attached ends first. It is not
    // ours, and treating it as ours would settle the edit before it started.
    drive(
      [
        {
          event: {
            data: { reason: { kind: "completed" }, turn: 4 },
            type: "turn/end",
          },
          type: "event",
        },
      ],
      ctx,
      state
    );
    expect(state.settled).toBe(false);

    drive(
      [
        {
          event: {
            data: {
              content: [],
              role: "user",
              source: { kind: "user", rpcId: "airship-mine" },
            },
            type: "user/message",
          },
          type: "event",
        },
      ],
      ctx,
      state
    );
    expect(state.armed).toBe(true);

    drive(
      [
        {
          event: {
            data: { reason: { kind: "completed" }, turn: 5 },
            type: "turn/end",
          },
          type: "event",
        },
      ],
      ctx,
      state
    );
    expect(state.settled).toBe(true);
    expect(state.stopReason).toBe("completed");
  });

  it("ignores a prompt that is not ours", () => {
    const { ctx } = context(process.cwd());
    const state = newAttachState("airship-mine");
    drive(
      [
        {
          event: {
            data: {
              content: [],
              role: "user",
              source: { kind: "user", rpcId: "someone-else" },
            },
            type: "user/message",
          },
          type: "event",
        },
      ],
      ctx,
      state
    );
    expect(state.armed).toBe(false);
  });
});

const liveUrl = process.env.AIRSHIP_DSH_ATTACH_URL;
const liveHome = process.env.AIRSHIP_DSH_ATTACH_HOME;

describe.skipIf(!(liveUrl && liveHome))("driving a running host", () => {
  it("runs one turn in a live session and reports what happened", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "airship-attach-"));
    try {
      const { ctx, items } = context(cwd, "Reply with exactly: attach-ok");
      const outcome = await runAttachedTurn(ctx, {
        home: liveHome as string,
        sessionId: process.env.AIRSHIP_DSH_ATTACH_SESSION,
        url: liveUrl as string,
      });

      expect(outcome.error).toBeUndefined();
      expect(outcome.sessionId).toMatch(SESSION_ID);
      expect(outcome.resultText).toContain("attach-ok");
      expect(items.some((i) => i.kind === "text")).toBe(true);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  }, 180_000);
});
