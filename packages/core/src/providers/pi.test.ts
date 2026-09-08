/**
 * Drives the pi event reducer over a hand-written RPC stream.
 *
 * This is the reason `reducePiEvent` is separate from `run`: the alternative
 * is spawning the real CLI and hoping it produces the events you want to
 * assert on. Everything here is the translation layer, which is where the pi
 * path's actual risk lives.
 */

import type {
  TimelineItem,
  TimelineTextItem,
  TimelineToolItem,
} from "@airship/protocol";
import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "../agent";
import { DiffCapture } from "../diff-capture";
import { TimelineRecorder } from "../timeline";
import {
  finishPiRun,
  newPiState,
  type PiReduceState,
  piArgs,
  reducePiEvent,
} from "./pi";
import { normalizePiTool, type PiEvent } from "./pi-events";

function makeCtx(input: Record<string, unknown> = {}): {
  ctx: AgentRunContext;
  items: TimelineItem[];
  steps: string[];
  text: string[];
} {
  const items: TimelineItem[] = [];
  const steps: string[] = [];
  const text: string[] = [];
  const recorder = new TimelineRecorder({
    onItem: (item) => items.push(item),
  });
  const ctx = {
    diffs: new DiffCapture("/tmp/airship-test"),
    emitStep: (s: string) => steps.push(s),
    events: { onText: (t: string) => text.push(t) },
    input: { cwd: "/tmp/airship-test", prompt: "", ...input },
    promptText: "",
    recorder,
  } as unknown as AgentRunContext;
  return { ctx, items, steps, text };
}

function drive(events: PiEvent[], ctx: AgentRunContext): PiReduceState {
  const state = newPiState();
  for (const event of events) {
    reducePiEvent(event, ctx, state, { rescanDirty: () => new Set() });
  }
  return state;
}

const tools = (items: TimelineItem[]): TimelineToolItem[] =>
  items.filter((i): i is TimelineToolItem => i.kind === "tool");
const prose = (items: TimelineItem[]): TimelineTextItem[] =>
  items.filter((i): i is TimelineTextItem => i.kind === "text");

const update = (
  assistantMessageEvent: Extract<
    PiEvent,
    { type: "message_update" }
  >["assistantMessageEvent"]
): PiEvent => ({
  assistantMessageEvent,
  type: "message_update",
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0 },
    input: 0,
    output: 0,
  },
});

describe("reducePiEvent", () => {
  it("streams prose and lifts the structured payload out of the final text", () => {
    const { ctx, items, text } = makeCtx();
    const payload =
      '{"summary":"Made the button blue.","filesChanged":["src/a.tsx"],"followUps":["Darken on hover"]}';
    const state = drive(
      [
        { type: "agent_start" },
        { message: { role: "assistant" }, type: "message_start" },
        update({ contentIndex: 0, type: "text_start" }),
        update({
          contentIndex: 0,
          delta: "Done — the button ",
          type: "text_delta",
        }),
        update({
          contentIndex: 0,
          delta: "is blue now.\n\n<struct",
          type: "text_delta",
        }),
        update({
          contentIndex: 0,
          delta: `uredoutput>${payload}</structuredoutput>`,
          type: "text_delta",
        }),
        update({
          content: `Done — the button is blue now.\n\n<structuredoutput>${payload}</structuredoutput>`,
          contentIndex: 0,
          type: "text_end",
        }),
        {
          message: {
            content: [],
            role: "assistant",
            stopReason: "stop",
            usage: {
              cacheRead: 10,
              cost: { total: 0.002 },
              input: 90,
              output: 40,
            },
          },
          type: "message_end",
        },
        { type: "agent_end", willRetry: false },
        { type: "agent_settled" },
      ],
      ctx
    );

    const { resultText, structured } = finishPiRun(state);
    expect(structured?.summary).toBe("Made the button blue.");
    expect(structured?.filesChanged).toEqual(["src/a.tsx"]);
    expect(resultText).toBe("Done — the button is blue now.");
    // Nothing of the tag ever reached the client.
    expect(text.join("")).toBe("Done — the button is blue now.");
    expect(prose(items)).toHaveLength(1);
    expect(state.settled).toBe(true);
    expect(state.usage).toEqual({
      costUsd: 0.002,
      inputTokens: 100,
      outputTokens: 40,
    });
  });

  it("opens a tool row on start and closes it with the result on end", () => {
    const { ctx, items, steps } = makeCtx();
    drive(
      [
        {
          args: { command: "pnpm test" },
          toolCallId: "call_1",
          toolName: "bash",
          type: "tool_execution_start",
        },
        {
          isError: true,
          result: { content: [{ text: "1 failing", type: "text" }] },
          toolCallId: "call_1",
          toolName: "bash",
          type: "tool_execution_end",
        },
      ],
      ctx
    );
    const [row] = tools(items);
    expect(row?.title).toBe("Bash(pnpm test)");
    expect(steps).toContain("Running pnpm");
    // A failing command is information, not a broken tool: the row carries the
    // exit code and output rather than collapsing to a bare error.
    expect(row?.result?.text ?? "").toContain("exit 1");
    expect(row?.result?.detail ?? "").toContain("1 failing");
  });

  it("maps edits onto the shared vocabulary and records the write", () => {
    const { ctx, items } = makeCtx();
    drive(
      [
        {
          args: {
            edits: [{ newText: "b", oldText: "a" }],
            path: "src/a.tsx",
          },
          toolCallId: "call_2",
          toolName: "edit",
          type: "tool_execution_start",
        },
        {
          isError: false,
          result: { content: [{ text: "ok", type: "text" }] },
          toolCallId: "call_2",
          toolName: "edit",
          type: "tool_execution_end",
        },
      ],
      ctx
    );
    const [row] = tools(items);
    expect(row?.title).toBe("Edit(src/a.tsx)");
  });

  it("surfaces a model error without inventing a payload", () => {
    const { ctx } = makeCtx();
    const state = drive(
      [
        { message: { role: "assistant" }, type: "message_start" },
        {
          message: {
            content: [],
            errorMessage: "HTTP 502 from upstream",
            role: "assistant",
            stopReason: "error",
          },
          type: "message_end",
        },
        { type: "agent_settled" },
      ],
      ctx
    );
    expect(state.error).toBe("HTTP 502 from upstream");
    expect(finishPiRun(state).structured).toBeNull();
  });

  it("treats a rejected prompt as a settled failure", () => {
    const { ctx } = makeCtx();
    const state = drive(
      [
        {
          command: "prompt",
          error: "agent is streaming",
          id: "edit",
          success: false,
          type: "response",
        },
      ],
      ctx
    );
    expect(state.settled).toBe(true);
    expect(state.error).toBe("agent is streaming");
  });
});

describe("piArgs", () => {
  it("runs headless, isolated from user extensions, on the requested model", () => {
    const { ctx } = makeCtx({
      effort: "low",
      model: "runpod/qwen3.8-27b",
      resumeSessionId: "abc123",
    });
    const args = piArgs(ctx);
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--system-prompt");
    expect(args).toEqual(
      expect.arrayContaining([
        "--model",
        "runpod/qwen3.8-27b",
        "--thinking",
        "low",
      ])
    );
    expect(args.slice(-2)).toEqual(["--session", "abc123"]);
  });

  it("forks rather than resumes when asked for a fresh attempt", () => {
    const { ctx } = makeCtx({
      fork: true,
      resumeSessionId: "abc123",
      safe: true,
    });
    const args = piArgs(ctx);
    expect(args.slice(-2)).toEqual(["--fork", "abc123"]);
    expect(args).toContain("--tools");
  });
});

describe("normalizePiTool", () => {
  it("renames pi's fields onto the ones the summarizer reads", () => {
    expect(
      normalizePiTool("t1", "read", { limit: 20, path: "a.ts" })
    ).toMatchObject({
      input: { file_path: "a.ts", limit: 20 },
      name: "Read",
    });
    expect(
      normalizePiTool("t2", "grep", { path: "src", pattern: "foo" }).name
    ).toBe("Grep");
    expect(normalizePiTool("t3", "find", { pattern: "*.ts" }).name).toBe(
      "Glob"
    );
    expect(
      normalizePiTool("t4", "edit", { edits: [{}, {}], path: "b.ts" }).name
    ).toBe("MultiEdit");
  });
});
