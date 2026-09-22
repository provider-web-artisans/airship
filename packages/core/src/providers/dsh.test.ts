/**
 * Drives the dsh ACP reducer over a hand-written update stream.
 *
 * This is the reason `reduceAcpUpdate` is separate from `run`: the alternative
 * is spawning the real CLI and hoping it produces the updates you want to
 * assert on. Everything here is the translation layer, which is where the dsh
 * path's actual risk lives — the frames are copied from a real turn, tags and
 * all, rather than from the protocol document.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TimelineItem,
  TimelineTextItem,
  TimelineThinkingItem,
  TimelineToolItem,
} from "@airship/protocol";
import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "../agent";
import { DiffCapture } from "../diff-capture";
import { TimelineRecorder } from "../timeline";
import {
  type AcpReduceState,
  dshArgs,
  finishAcpRun,
  finishAcpTurn,
  newAcpState,
  reduceAcpUpdate,
} from "./dsh";
import {
  type AcpUpdate,
  acpChoices,
  chooseEffortValue,
  normalizeAcpTool,
  parseBashResult,
  resolveModelValue,
  usageFromAcpUpdate,
} from "./dsh-acp";

function makeCtx(input: Record<string, unknown> = {}): {
  ctx: AgentRunContext;
  items: TimelineItem[];
  steps: string[];
  text: string[];
} {
  const cwd = (input.cwd as string | undefined) ?? "/tmp/airship-test";
  const items: TimelineItem[] = [];
  const steps: string[] = [];
  const text: string[] = [];
  const recorder = new TimelineRecorder({
    onItem: (item) => items.push(item),
  });
  const ctx = {
    diffs: new DiffCapture(cwd),
    emitStep: (s: string) => steps.push(s),
    events: { onText: (t: string) => text.push(t) },
    input: { cwd, prompt: "", ...input },
    promptText: "",
    recorder,
  } as unknown as AgentRunContext;
  return { ctx, items, steps, text };
}

function drive(
  updates: AcpUpdate[],
  ctx: AgentRunContext,
  stopReason: string | null = "end_turn"
): AcpReduceState {
  const state = newAcpState();
  for (const update of updates) {
    reduceAcpUpdate(update, ctx, state, { rescanDirty: () => new Set() });
  }
  finishAcpTurn(state, ctx, stopReason);
  return state;
}

const tools = (items: TimelineItem[]): TimelineToolItem[] =>
  items.filter((i): i is TimelineToolItem => i.kind === "tool");
const prose = (items: TimelineItem[]): TimelineTextItem[] =>
  items.filter((i): i is TimelineTextItem => i.kind === "text");
const thinking = (items: TimelineItem[]): TimelineThinkingItem[] =>
  items.filter((i): i is TimelineThinkingItem => i.kind === "thinking");

/** The config options a real `session/new` answered with, trimmed to shape. */
const CONFIG_OPTIONS = [
  {
    category: "model",
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    id: "model",
    name: "Model",
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          {
            name: "DeepSeek-V4-Flash",
            value: '["deepseek-official","deepseek-v4-flash"]',
          },
          {
            name: "DeepSeek-V4-Pro",
            value: '["deepseek-official","deepseek-v4-pro"]',
          },
        ],
      },
    ],
    type: "select",
  },
  {
    category: "thought_level",
    currentValue: "high",
    id: "reasoning_effort",
    name: "Reasoning effort",
    options: [
      { name: "Off", value: "off" },
      { name: "Low", value: "low" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    type: "select",
  },
];

const [MODEL_OPTION, EFFORT_OPTION] = CONFIG_OPTIONS;

describe("reduceAcpUpdate", () => {
  it("streams prose and lifts the structured payload out of the final text", () => {
    const { ctx, items, text } = makeCtx();
    const payload =
      '{"summary":"Made the button blue.","filesChanged":["src/a.tsx"],"followUps":["Darken on hover"]}';
    const state = drive(
      [
        {
          content: { text: "Done — the button " },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
        {
          content: { text: "is blue now.\n\n<struct" },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
        {
          content: { text: `uredoutput>${payload}</structuredoutput>` },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
        { sessionUpdate: "usage_update", size: 1_000_000, used: 11_161 },
      ],
      ctx
    );

    const { resultText, structured } = finishAcpRun(state);
    expect(structured?.summary).toBe("Made the button blue.");
    expect(structured?.filesChanged).toEqual(["src/a.tsx"]);
    expect(resultText).toBe("Done — the button is blue now.");
    // Nothing of the tag ever reached the client.
    expect(text.join("")).toBe("Done — the button is blue now.");
    expect(prose(items)).toHaveLength(1);
    expect(state.settled).toBe(true);
    expect(state.stopReason).toBe("end_turn");
  });

  it("keeps reasoning in its own block, apart from the prose", () => {
    const { ctx, items, steps, text } = makeCtx();
    drive(
      [
        {
          content: { text: "Step 1: read the file." },
          messageId: "m1",
          sessionUpdate: "agent_thought_chunk",
        },
        {
          content: { text: "Done." },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
      ],
      ctx
    );
    expect(thinking(items)).toHaveLength(1);
    expect(prose(items)).toHaveLength(1);
    expect(steps).toContain("Thinking");
    // Reasoning is drawn as its own block and never as assistant prose.
    expect(text.join("")).toBe("Done.");
  });

  it("opens a tool row on the call and closes it with the result", () => {
    const { ctx, items, steps } = makeCtx();
    drive(
      [
        {
          kind: "other",
          rawInput: { command: "exit 7", description: "Fail deliberately" },
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "bash",
          toolCallId: "call_1",
        },
        {
          content: [
            {
              content: { text: "(no output)\n[exit code: 7]", type: "text" },
              type: "content",
            },
          ],
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "call_1",
        },
      ],
      ctx
    );
    const [row] = tools(items);
    expect(row?.title).toBe("Bash(exit 7)");
    expect(steps).toContain("Running exit");
    // A non-zero exit is information, not a broken tool: the row carries the
    // real code, and the `(no output)` placeholder is not output.
    expect(row?.result?.text ?? "").toBe("exit 7");
    expect(row?.phase).toBe("ok");
  });

  it("says a tool failed when it never reached the shell", () => {
    const { ctx, items } = makeCtx();
    drive(
      [
        {
          rawInput: { command: "sleep 45" },
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "bash",
          toolCallId: "call_2",
        },
        {
          content: [
            {
              content: { text: "Error: tool call aborted", type: "text" },
              type: "content",
            },
          ],
          sessionUpdate: "tool_call_update",
          status: "failed",
          toolCallId: "call_2",
        },
      ],
      ctx
    );
    const [row] = tools(items);
    // dsh's `Error: …` and the summarizer's own prefix must not both land.
    expect(row?.result?.text ?? "").toBe("Error: tool call aborted");
    expect(row?.phase).toBe("error");
  });

  it("records a write and synthesizes a real patch for the row", () => {
    const cwd = mkdtempSync(join(tmpdir(), "airship-dsh-"));
    try {
      const target = join(cwd, "out.txt");
      const { ctx, items } = makeCtx({ cwd });
      // The write has already happened by the time ACP reports it, so the file
      // is on disk before the reducer ever sees the call.
      writeFileSync(target, "made by dsh");
      drive(
        [
          {
            kind: "other",
            rawInput: { content: "made by dsh", file_path: target },
            sessionUpdate: "tool_call",
            status: "in_progress",
            title: "write",
            toolCallId: "call_3",
          },
          {
            content: [
              {
                content: { text: "Created file", type: "text" },
                type: "content",
              },
            ],
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId: "call_3",
          },
        ],
        ctx
      );
      const [row] = tools(items);
      // The recorder shortens a long path for the row, so the tail is what to
      // assert on.
      expect(row?.title ?? "").toContain("out.txt");
      expect(row?.title ?? "").toContain("Write(");
      // A brand-new file diffs from nothing, and the synthesized patch is what
      // gives the row its counts.
      expect(row?.result?.text ?? "").toBe("+1 −0");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("starts a new prose block after a tool call interrupts one", () => {
    const { ctx, items } = makeCtx();
    drive(
      [
        {
          content: { text: "Reading it now." },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
        {
          kind: "other",
          rawInput: { file_path: "hello.txt" },
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "read",
          toolCallId: "call_4",
        },
        {
          content: { text: "All done." },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
      ],
      ctx
    );
    // Same message id, but a tool ran in between: the second run is its own
    // block, or the two would interleave inside one row.
    expect(prose(items)).toHaveLength(2);
    expect(tools(items)[0]?.title).toBe("Read(hello.txt)");
  });

  it("settles a cancelled turn without reporting a failure of its own", () => {
    const { ctx, items } = makeCtx();
    const state = drive(
      [
        {
          content: { text: "Half a sen" },
          messageId: "m1",
          sessionUpdate: "agent_message_chunk",
        },
      ],
      ctx,
      "cancelled"
    );
    expect(state.settled).toBe(true);
    expect(state.stopReason).toBe("cancelled");
    expect(state.block).toBeNull();
    expect(prose(items)).toHaveLength(1);
  });

  it("ignores updates this timeline does not draw", () => {
    const { ctx, items, steps } = makeCtx();
    const state = drive(
      [{ sessionUpdate: "plan" }, { sessionUpdate: "current_mode_update" }],
      ctx
    );
    expect(items).toHaveLength(0);
    expect(steps).toHaveLength(0);
    expect(state.error).toBeUndefined();
  });
});

describe("usageFromAcpUpdate", () => {
  it("maps the context meter, and invents no split", () => {
    expect(usageFromAcpUpdate({ used: 11_126 })).toEqual({
      inputTokens: 11_126,
    });
    expect(usageFromAcpUpdate({ used: 0 })).toBeUndefined();
    expect(usageFromAcpUpdate({})).toBeUndefined();
  });
});

describe("resolveModelValue", () => {
  const model = MODEL_OPTION;

  it("accepts the encoded selection, a provider/id pair, and a bare id", () => {
    expect(
      resolveModelValue(model, '["deepseek-official","deepseek-v4-pro"]')
    ).toEqual({ value: '["deepseek-official","deepseek-v4-pro"]' });
    expect(
      resolveModelValue(model, "deepseek-official/deepseek-v4-pro")
    ).toEqual({ value: '["deepseek-official","deepseek-v4-pro"]' });
    expect(resolveModelValue(model, "deepseek-v4-pro")).toEqual({
      value: '["deepseek-official","deepseek-v4-pro"]',
    });
  });

  it("refuses a model this profile does not advertise", () => {
    const resolved = resolveModelValue(model, "gpt-9");
    expect("error" in resolved && resolved.error).toContain(
      "No model matching `gpt-9`"
    );
  });
});

describe("chooseEffortValue", () => {
  const effort = EFFORT_OPTION;

  it("places Airship's six levels on dsh's four rungs", () => {
    expect(chooseEffortValue(effort, "minimal")).toBe("off");
    expect(chooseEffortValue(effort, "low")).toBe("low");
    expect(chooseEffortValue(effort, "medium")).toBe("high");
    expect(chooseEffortValue(effort, "high")).toBe("high");
    expect(chooseEffortValue(effort, "xhigh")).toBe("max");
    expect(chooseEffortValue(effort, "max")).toBe("max");
    expect(chooseEffortValue(effort, undefined)).toBeUndefined();
  });

  it("takes the nearest advertised rung when the model lacks the exact one", () => {
    const narrow = {
      options: [
        { name: "Low", value: "low" },
        { name: "High", value: "high" },
      ],
    };
    expect(chooseEffortValue(narrow, "minimal")).toBe("low");
    expect(chooseEffortValue(narrow, "max")).toBe("high");
    // A deployment-specific level is left for the model to judge.
    expect(chooseEffortValue({ options: [{ value: "turbo" }] }, "high")).toBe(
      undefined
    );
  });
});

describe("acpChoices", () => {
  it("flattens the grouped model list and the flat effort list alike", () => {
    expect(acpChoices(CONFIG_OPTIONS[0]).map((c) => c.value)).toEqual([
      '["deepseek-official","deepseek-v4-flash"]',
      '["deepseek-official","deepseek-v4-pro"]',
    ]);
    expect(acpChoices(CONFIG_OPTIONS[1]).map((c) => c.value)).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
    expect(acpChoices(undefined)).toEqual([]);
  });
});

describe("parseBashResult", () => {
  it("splits the exit marker and the placeholder off the output", () => {
    expect(parseBashResult("(no output)\n[exit code: 7]")).toEqual({
      exitCode: 7,
      stdout: "",
    });
    expect(parseBashResult("line one\nline two\n[exit code: 0]")).toEqual({
      exitCode: 0,
      stdout: "line one\nline two",
    });
    expect(parseBashResult("boom")).toEqual({ exitCode: null, stdout: "boom" });
  });
});

describe("normalizeAcpTool", () => {
  it("carries dsh's fields onto the ones the summarizer reads", () => {
    expect(
      normalizeAcpTool("t1", "read", { file_path: "a.ts", limit: 20 })
    ).toMatchObject({
      input: { file_path: "a.ts", limit: 20 },
      name: "Read",
    });
    expect(
      normalizeAcpTool("t2", "edit", {
        file_path: "b.ts",
        new_string: "b",
        old_string: "a",
      }).name
    ).toBe("Edit");
    expect(normalizeAcpTool("t3", "grep", { pattern: "foo" }).name).toBe(
      "Grep"
    );
    expect(normalizeAcpTool("t4", "glob", { pattern: "*.ts" }).name).toBe(
      "Glob"
    );
    // Anything unmapped keeps its own name, which is the honest outcome.
    expect(normalizeAcpTool("t5", "custom_tool", {}).name).toBe("custom_tool");
  });

  it("gives the shell row an exit code and the output, not the marker", () => {
    const tool = normalizeAcpTool(
      "t6",
      "bash",
      { command: "exit 7" },
      {
        isError: false,
        text: "(no output)\n[exit code: 7]",
      }
    );
    expect(tool.content).toBe("");
    expect(tool.isError).toBe(false);
    expect(tool.typed).toEqual({ exitCode: 7, stdout: "" });
  });
});

describe("the dsh child", () => {
  it("boots the ACP profile", () => {
    expect(dshArgs()).toEqual(["--profile", "acp"]);
  });
});
