/**
 * `airship inspect` — what a launch in this directory would do, before it does.
 *
 * `serve` already works out the dev server's port when `--target` is omitted,
 * and the wizard prefills it; neither can be asked without launching. A host
 * that puts a button in front of `airship` — the DeepSeek Harness plugin — has
 * to answer "what port, is it up, how would I start it" *before* the click,
 * so the person confirms a guess instead of typing one. This is that answer,
 * from the same detection `serve` uses, and nothing else: no probe of the
 * agents, no git — `doctor` is for that.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { argsFor, assertKnownFlags, GLOBAL_FLAGS } from "../lib/args";
import { asBoolean, asString, type Settings } from "../lib/config";
import {
  type Candidate,
  candidatePorts,
  isListening,
  readPackageJson,
} from "../lib/detect";
import { resolveSettings } from "../lib/settings";
import { out, setColorEnabled, shouldColor, style } from "../lib/terminal";

export const INSPECT_FLAGS: readonly string[] = [
  "cwd",
  "target",
  "exec",
  ...GLOBAL_FLAGS,
];

/** One port worth trying, and whether it answers right now. */
export interface InspectedPort extends Candidate {
  listening: boolean;
}

export interface Inspection {
  /** Settings the project's config or the environment already pin. */
  config: { exec?: string; target?: number };
  /** Project root, absolute. */
  cwd: string;
  /** The `dev`/`start`/`serve` script, as package.json spells it. */
  devScript?: { command: string; name: string };
  /** The project's name from package.json, when it has one. */
  name?: string;
  /** The package manager the lockfile implies; `npm` when none does. */
  packageManager: PackageManager;
  /** Candidates in `serve`'s order; the first listening one is what it would pick. */
  ports: InspectedPort[];
  /** How to start the dev script with that package manager, when there is one. */
  startCommand?: string;
}

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

/** Lockfiles, most specific first: a repo with two is answering for the first. */
const LOCKFILES: readonly [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export function packageManagerOf(cwd: string): PackageManager {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(cwd, file))) {
      return manager;
    }
  }
  return "npm";
}

/** The script `candidatePorts` reads, named, so a caller can run it. */
function devScriptOf(
  pkg: Record<string, unknown> | undefined
): Inspection["devScript"] {
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  for (const name of ["dev", "start", "serve"]) {
    const command = scripts[name];
    if (typeof command === "string" && command.trim()) {
      return { command, name };
    }
  }
}

/**
 * `<manager> run <script>`, in each manager's own idiom: `pnpm dev` and
 * `yarn dev` are how their users write it, `npm run dev` is npm's.
 */
function startCommandFor(manager: PackageManager, script: string): string {
  if (manager === "npm" && script !== "start") {
    return `npm run ${script}`;
  }
  if (manager === "bun") {
    return `bun run ${script}`;
  }
  return `${manager} ${script}`;
}

/**
 * Everything a launch would decide, decided without launching.
 *
 * @param cwd - the project root.
 * @param settings - the resolved settings, for a pinned `target` or `exec`.
 * @param probe - port probe; injected so the report is testable offline.
 */
export async function inspectProject(
  cwd: string,
  settings: Settings,
  probe: (port: number) => Promise<boolean> = (port) => isListening(port)
): Promise<Inspection> {
  const pkg = readPackageJson(cwd);
  const candidates = candidatePorts(cwd);
  // All at once, unlike `detectTarget`: this reports every candidate rather
  // than stopping at the first hit, so there is no order to preserve.
  const ports = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      listening: await probe(candidate.port),
    }))
  );
  const packageManager = packageManagerOf(cwd);
  const devScript = devScriptOf(pkg);
  const target = asString(settings, "target");
  const targetPort = target === undefined ? undefined : Number(target);
  return {
    config: {
      exec: asString(settings, "exec"),
      target:
        targetPort !== undefined && Number.isInteger(targetPort)
          ? targetPort
          : undefined,
    },
    cwd,
    devScript,
    name: typeof pkg?.name === "string" ? pkg.name : undefined,
    packageManager,
    ports,
    startCommand: devScript
      ? startCommandFor(packageManager, devScript.name)
      : undefined,
  };
}

function report(inspection: Inspection): string {
  const lines: string[] = [];
  lines.push(
    `${style.bold(inspection.name ?? "project")}  ${style.dim(inspection.cwd)}`
  );
  if (inspection.ports.length === 0) {
    lines.push("  no dev-server port could be guessed");
  }
  for (const port of inspection.ports) {
    const mark = port.listening ? style.green("✓") : style.dim("·");
    const state = port.listening ? "listening" : "not listening";
    lines.push(`  ${mark} ${String(port.port)}  ${port.reason} — ${state}`);
  }
  if (inspection.startCommand) {
    lines.push(
      `  start: ${inspection.startCommand}  ${style.dim(`(${inspection.devScript?.command ?? ""})`)}`
    );
  }
  if (inspection.config.target !== undefined) {
    lines.push(`  config pins target ${String(inspection.config.target)}`);
  }
  if (inspection.config.exec) {
    lines.push(`  config pins exec "${inspection.config.exec}"`);
  }
  return `${lines.join("\n")}\n`;
}

export const inspect = defineCommand({
  args: argsFor(INSPECT_FLAGS),
  meta: {
    description: "Report the dev server a launch here would target.",
    name: "inspect",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, INSPECT_FLAGS);
    const { cwd, settings } = resolveSettings({
      args,
      names: INSPECT_FLAGS,
      rawArgs,
    });
    const json = asBoolean(settings, "json");
    setColorEnabled(shouldColor({ json }));
    const inspection = await inspectProject(cwd, settings);
    out(json ? `${JSON.stringify(inspection, null, 2)}\n` : report(inspection));
  },
});
