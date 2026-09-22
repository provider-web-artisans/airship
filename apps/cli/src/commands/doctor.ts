/**
 * `airship doctor` — why it did not work.
 *
 * The CLI has never had an answer to that. Every failure mode it has (an agent
 * that is not signed in, a dev server that is not running, a project that is not
 * a git repo, an overlay bundle that was never built) previously surfaced either
 * as a warning buried in a launch it was too late to stop, or as nothing at all.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT } from "@airship/protocol";
import { type AgentKind, checkAuth, gitStatus } from "@airship/server";
import { defineCommand } from "citty";
import {
  AGENTS,
  argsFor,
  assertKnownFlags,
  GLOBAL_FLAGS,
  requirePort,
} from "../lib/args";
import {
  asBoolean,
  asString,
  CONFIG_FILENAME,
  type Settings,
} from "../lib/config";
import { detectTarget, isListening } from "../lib/detect";
import { resolveSettings } from "../lib/settings";
import {
  note,
  out,
  setColorEnabled,
  shouldColor,
  style,
} from "../lib/terminal";
import { VERSION } from "../lib/version";

export const DOCTOR_FLAGS: readonly string[] = [
  "cwd",
  "target",
  "agent",
  // The per-backend locations `init` and `serve` accept, and which `doctor`
  // therefore has to accept too — a backend that is not on PATH is the case
  // this command exists for, and refusing the flag that points at it turns
  // "check my setup" into "your setup is wrong".
  "dsh-path",
  "dsh-agent-dir",
  "pi-path",
  "pi-agent-dir",
  ...GLOBAL_FLAGS,
];

type Level = "ok" | "warn" | "fail";

interface Check {
  /** What to do about it. Omitted when there is nothing to do. */
  hint?: string;
  label: string;
  level: Level;
  value: string;
}

const MARKS: Record<Level, (text: string) => string> = {
  fail: (text) => style.red(text),
  ok: (text) => style.green(text),
  warn: (text) => style.yellow(text),
};

const GLYPHS: Record<Level, string> = { fail: "✗", ok: "✓", warn: "⚠" };

/** Node's own floor, from the workspace `engines` field. */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;

function checkNode(): Check {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((part) => Number(part));
  const ok =
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  return {
    hint: ok
      ? undefined
      : `airship needs Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer.`,
    label: "node",
    level: ok ? "ok" : "fail",
    value: process.versions.node,
  };
}

async function checkAgents(
  preferred: AgentKind | undefined,
  binaries: ReadonlyMap<AgentKind, string>
): Promise<Check[]> {
  const results = await Promise.all(
    AGENTS.map(async (agent) => {
      // A binary named on the command line is where that backend is, so it
      // answers for the agent instead of the PATH probe. See `backendLocations`.
      const named = binaries.get(agent as AgentKind);
      const auth = named
        ? { ok: existsSync(named), reason: `No file at ${named}.` }
        : await checkAuth(agent as AgentKind);
      // Only the agent actually being used is a failure; the other two not
      // being installed is the normal state and must not read as broken.
      const isPreferred = agent === (preferred ?? DEFAULT_AGENT);
      let level: Level = "ok";
      if (!auth.ok) {
        level = isPreferred ? "fail" : "warn";
      }
      let value = "not available";
      if (auth.ok) {
        value = named ? `ready (${named})` : "ready";
      }
      return {
        hint: auth.ok ? undefined : auth.reason,
        label: `agent ${agent}`,
        level,
        value,
      } satisfies Check;
    })
  );
  return results;
}

/** A per-backend location flag, and the row it gets when it is set. */
interface BackendLocation {
  agent: AgentKind;
  /** `--<flag>` naming the backend's home/config directory. */
  dir?: { flag: string; label: string };
  /** `--<flag>` naming the backend's binary. */
  path?: { flag: string; label: string };
}

const BACKEND_LOCATIONS: readonly BackendLocation[] = [
  {
    agent: "dsh",
    dir: { flag: "dsh-agent-dir", label: "dsh home" },
    path: { flag: "dsh-path", label: "dsh binary" },
  },
  {
    agent: "pi",
    dir: { flag: "pi-agent-dir", label: "pi config" },
    path: { flag: "pi-path", label: "pi binary" },
  },
];

/** The row for a `--<agent>-path`, or null when the flag was not given. */
function binaryRow(
  agent: AgentKind,
  flag: string,
  label: string,
  binary: string | undefined,
  preferred: AgentKind | undefined
): Check | null {
  if (!binary) {
    return null;
  }
  const found = existsSync(binary);
  // Same rule as the agent rows: only the backend in use can fail the run.
  const blocked: Level =
    agent === (preferred ?? DEFAULT_AGENT) ? "fail" : "warn";
  return {
    hint: found
      ? undefined
      : `No file at ${binary} — check --${flag}, or unset it to search PATH.`,
    label,
    level: found ? "ok" : blocked,
    value: binary,
  };
}

/** The row for a `--<agent>-dir`, or null when the flag was not given. */
function homeRow(label: string, home: string | undefined): Check | null {
  if (!home) {
    return null;
  }
  const found = existsSync(home);
  return {
    hint: found
      ? undefined
      : "Not there yet. The backend creates it on first run if the path is right.",
    label,
    level: found ? "ok" : "warn",
    value: home,
  };
}

/**
 * Check the per-backend locations this command was given, and report the binary
 * each one names back to `checkAgents`.
 *
 * `checkAuth()` takes no per-backend settings — a gap it shares with every
 * backend, and one this file cannot close on its own — so a path given here is
 * checked directly rather than accepted and ignored. Ignoring it would be the
 * worst of the three available answers: the `agent <name>` row would report a
 * PATH probe on a run the user had explicitly pointed at their own build, and
 * the hint under it would tell them to pass the flag they had just passed.
 */
export function backendLocations(
  settings: Settings,
  preferred: AgentKind | undefined
): { binaries: Map<AgentKind, string>; checks: Check[] } {
  const binaries = new Map<AgentKind, string>();
  const checks: Check[] = [];

  for (const { agent, dir, path } of BACKEND_LOCATIONS) {
    const binary = path ? asString(settings, path.flag) : undefined;
    if (binary && path) {
      binaries.set(agent, binary);
    }
    const rows = [
      path ? binaryRow(agent, path.flag, path.label, binary, preferred) : null,
      dir ? homeRow(dir.label, asString(settings, dir.flag)) : null,
    ];
    for (const row of rows) {
      if (row) {
        checks.push(row);
      }
    }
  }

  return { binaries, checks };
}

function checkOverlay(): Check {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("@airship/overlay/bundle");
    return { label: "overlay bundle", level: "ok", value: "built" };
  } catch {
    // Same two-place lookup the proxy does, and for the same reason: in a
    // published install @airship/overlay is not on disk, and the bundle lives
    // in this CLI's own dist/vendor/. Checking only the workspace copy would
    // report "missing" on every working npm install.
    const vendored = fileURLToPath(
      new URL("./vendor/overlay.global.js", import.meta.url)
    );
    if (existsSync(vendored)) {
      return { label: "overlay bundle", level: "ok", value: "bundled" };
    }
    return {
      hint: "Run `pnpm build` — without it the editor cannot be injected.",
      label: "overlay bundle",
      level: "fail",
      value: "missing",
    };
  }
}

function render(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.label.length));
  const lines: string[] = [""];
  for (const check of checks) {
    const mark = MARKS[check.level](GLYPHS[check.level]);
    const label = check.label.padEnd(width);
    lines.push(`  ${mark} ${label}  ${check.value}`);
    if (check.hint) {
      lines.push(`    ${style.dim(`↳ ${check.hint}`)}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function checkConfig(configSource: string | undefined): Check {
  return {
    hint: configSource
      ? undefined
      : `No ${CONFIG_FILENAME} found — run \`airship init\` to create one.`,
    label: "config",
    level: configSource ? "ok" : "warn",
    value: configSource ?? "none (flags and env only)",
  };
}

/**
 * Two checks, because they fail for different reasons and have different fixes:
 * whether git can run at all, and whether this directory is somewhere it can
 * usefully run. They used to be one line that reported `isGitRepo` and nothing
 * else, so a machine with no git on PATH was told it was not in a repository.
 *
 * The level follows the same rule `checkAgents` uses: only the backend actually
 * being used can turn a missing dependency into a failure. Claude snapshots its
 * own before-state through a pre-tool hook, so it edits and undoes without git
 * at all; codex and opencode reconstruct their baseline from HEAD and cannot.
 * `doctor` exits non-zero on any `fail` and is documented as scriptable, so a
 * working Claude install must not be reported as broken.
 */
function checkGit(cwd: string, preferred: AgentKind | undefined): Check[] {
  const status = gitStatus(cwd);
  const needsGit = (preferred ?? DEFAULT_AGENT) !== "claude";
  const blocked: Level = needsGit ? "fail" : "warn";

  if (!status.installed) {
    return [
      {
        hint: status.hint,
        label: "git",
        level: blocked,
        value: "not installed",
      },
    ];
  }
  const version: Check = {
    label: "git",
    level: "ok",
    value: status.version ?? "installed",
  };
  if (!status.workTree) {
    return [
      version,
      {
        hint: status.hint,
        label: "git repo",
        level: blocked,
        value: `${status.error ?? "unusable"} (${cwd})`,
      },
    ];
  }
  if (!status.hasCommits) {
    return [
      version,
      {
        hint: status.hint,
        label: "git repo",
        level: blocked,
        value: "no commits yet",
      },
    ];
  }
  if (!status.identity) {
    return [
      version,
      // Always a warning, whichever backend: it breaks committing, which is one
      // opt-in button, and nothing else.
      { hint: status.hint, label: "git repo", level: "warn", value: cwd },
    ];
  }
  return [version, { label: "git repo", level: "ok", value: cwd }];
}

/**
 * A named `--target` is a claim the user made, so a dead port there is a
 * failure. A detected one is only a guess, so the same dead port is a warning.
 */
async function checkDevServer(
  cwd: string,
  targetFlag: string | undefined
): Promise<Check> {
  if (targetFlag) {
    const port = requirePort(targetFlag, "target");
    const live = await isListening(port);
    return {
      hint: live ? undefined : "Start it, or pass a different --target.",
      label: "dev server",
      level: live ? "ok" : "fail",
      value: live ? `listening on ${port}` : `nothing on ${port}`,
    };
  }

  const detected = await detectTarget(cwd);
  if (!detected) {
    return {
      hint: "Pass --target <port>.",
      label: "dev server",
      level: "warn",
      value: "no candidate ports found",
    };
  }
  return {
    hint: detected.listening
      ? undefined
      : "Start your dev server, or pass --target <port>.",
    label: "dev server",
    level: detected.listening ? "ok" : "warn",
    value: `${detected.listening ? "listening on" : "nothing on"} ${detected.port} (${detected.reason})`,
  };
}

export const doctor = defineCommand({
  args: argsFor(DOCTOR_FLAGS),
  meta: {
    description: "Check your environment and report what is wrong.",
    name: "doctor",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, DOCTOR_FLAGS);
    const { configSource, cwd, settings } = resolveSettings({
      args,
      names: DOCTOR_FLAGS,
      rawArgs,
    });
    const json = asBoolean(settings, "json");
    setColorEnabled(shouldColor({ json }));

    const agent = asString(settings, "agent") as AgentKind | undefined;
    const locations = backendLocations(settings, agent);

    const checks: Check[] = [
      checkNode(),
      { label: "airship", level: "ok", value: VERSION },
      checkConfig(configSource),
      ...checkGit(cwd, agent),
      checkOverlay(),
      ...locations.checks,
      ...(await checkAgents(agent, locations.binaries)),
      // The dev server last: it is the check most likely to be a transient
      // "not started yet", and it reads better after the things that stay true.
      await checkDevServer(cwd, asString(settings, "target")),
    ];

    if (json) {
      out(`${JSON.stringify({ checks, cwd }, null, 2)}\n`);
    } else {
      note(render(checks));
    }

    // A failing check is a failing run, so `airship doctor && airship` is a
    // usable thing to write in a script.
    if (checks.some((check) => check.level === "fail")) {
      process.exitCode = 1;
    }
  },
});
