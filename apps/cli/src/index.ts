/**
 * The entry point: routing, help, and exit codes.
 *
 * Dispatch is done here rather than through citty's `subCommands` for two
 * reasons. citty runs a parent's `run` *after* the matched subcommand, so a root
 * that both serves and has subcommands would launch a server on `airship
 * doctor`; and its `runMain` prints the whole usage page and exits 1 for every
 * failure, which turns a one-line typo into a screenful and loses the exit code
 * a script would branch on. citty stays the parsing and command-definition
 * layer; the choke point is here.
 */

import { onGitFailure } from "@airship/server";
import { runCommand } from "citty";
import { DOCTOR_FLAGS, doctor } from "./commands/doctor";
import { INIT_FLAGS, init } from "./commands/init";
import { SERVE_FLAGS, serve } from "./commands/serve";
import { CliError, didYouMean, EXIT, reportError } from "./lib/errors";
import {
  isInteractive,
  out,
  setColorEnabled,
  shouldColor,
  style,
} from "./lib/terminal";
import { type CommandHelp, renderHelp } from "./lib/usage";
import { VERSION } from "./lib/version";
import { noTtyError, runWizard } from "./lib/wizard";

const TAGLINE =
  "airship — visual web-app editor powered by Claude Code, OpenAI Codex, OpenCode, pi or the DeepSeek Harness";

const SUBCOMMANDS = {
  doctor: {
    command: doctor,
    flags: DOCTOR_FLAGS,
    summary: "Check your environment and report what is wrong.",
  },
  init: {
    command: init,
    flags: INIT_FLAGS,
    summary: "Create an airship.config.json for this project.",
  },
} as const;

type CommandName = keyof typeof SUBCOMMANDS;

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(SUBCOMMANDS, value);
}

/** Prose that belongs in help but describes behaviour, not a single flag. */
const SECTIONS = [
  {
    body: `By default the agent runs unsandboxed — it can write anywhere you can and reach the network. Pass --safe to confine edits to the project directory, cut network access, and screen destructive shell commands.

Only codex confines writes at the OS level. On claude and opencode --safe screens edits by path and commands by pattern, which does not parse shell — a write redirected out of the project is not caught. Neither cuts raw network access, though both disable their built-in web tools. On pi --safe only narrows its toolset. On dsh --safe is best-effort: airship hands the child DSH_PERMISSION_MODE=read-only, dsh's own settings can outrank it, and there is no edit or command screen either way.`,
    title: "Sandboxing",
  },
  {
    body: "opencode is a separate install (`brew install sst/tap/opencode`); airship finds it on PATH. Its --model wants the `provider/model` form, and it has no reasoning-effort control, so --effort, --max-turns and --max-budget do not apply.\n\npi is a separate install too (`npm i -g @earendil-works/pi-coding-agent`). Its --model takes pi's `provider/model` form, including custom providers from models.json — point --pi-agent-dir at a config directory to ship one. --effort maps onto pi's thinking level; --max-turns and --max-budget do not apply, and --safe only narrows its toolset.\n\ndsh is the DeepSeek Harness, found on PATH or at --dsh-path. --dsh-model takes a bare model id (`deepseek-v4-flash`), not a provider/model ref, and --dsh-agent-dir points DSH_HOME at another profile tree; the picker offers airship's built-in list rather than asking dsh. --max-turns and --max-budget do not apply.",
    title: "Backends",
  },
  {
    body: "Settings resolve in this order, highest first: flags, then AIRSHIP_* environment variables, then airship.config.json (searched upwards from the project, stopping at the repository root). Run `airship init` to write one.",
    title: "Configuration",
  },
];

const ROOT_HELP: CommandHelp = {
  examples: [
    { command: "airship", note: "detect the port, pick an agent, launch" },
    { command: "airship --target 3000", note: "dev server already on :3000" },
    { command: "airship -t 3000 --mode inline" },
    {
      command: 'airship --exec "pnpm dev"',
      note: "start the dev server too, and stop it on exit",
    },
    { command: "airship doctor", note: "why is it not working" },
  ],
  flags: SERVE_FLAGS,
  sections: SECTIONS,
  subcommands: Object.entries(SUBCOMMANDS).map(([name, entry]) => ({
    name,
    summary: entry.summary,
  })),
  tagline: TAGLINE,
  usage: [
    "airship [options]",
    "airship --target <port> [options]",
    "airship <command> [options]",
  ],
};

function subcommandHelp(name: CommandName): CommandHelp {
  const entry = SUBCOMMANDS[name];
  return {
    flags: entry.flags,
    tagline: `airship ${name} — ${entry.summary}`,
    usage: [`airship ${name} [options]`],
  };
}

const ALL_DIGITS = /^\d+$/;

/** `--` ends our flags, so a help flag after it belongs to something else. */
function hasFlag(rawArgs: readonly string[], ...names: string[]): boolean {
  for (const raw of rawArgs) {
    if (raw === "--") {
      return false;
    }
    if (names.includes(raw)) {
      return true;
    }
  }
  return false;
}

/**
 * A bare invocation at a terminal asks rather than printing help and failing.
 * The answers become argv so there is exactly one path into `serve`.
 */
async function wizardArgs(): Promise<string[]> {
  if (!isInteractive()) {
    throw noTtyError();
  }
  const answers = await runWizard(process.cwd());
  return [
    "--target",
    String(answers.target),
    "--agent",
    answers.agent,
    "--mode",
    answers.mode,
    ...(answers.safe ? ["--safe"] : []),
  ];
}

async function main(rawArgs: string[]): Promise<void> {
  const [first] = rawArgs;
  const command = first && isCommandName(first) ? first : undefined;

  if (hasFlag(rawArgs, "--help", "-h")) {
    out(renderHelp(command ? subcommandHelp(command) : ROOT_HELP));
    return;
  }
  if (hasFlag(rawArgs, "--version", "-v")) {
    out(`${VERSION}\n`);
    return;
  }

  if (command) {
    await runCommand(SUBCOMMANDS[command].command, {
      rawArgs: rawArgs.slice(1),
    });
    return;
  }

  if (first !== undefined && !first.startsWith("-")) {
    // A stray positional. The common one is `airship 3000`, which is a real
    // intention typed the wrong way, so say what they meant rather than only
    // that it is not a command.
    const numeric = ALL_DIGITS.test(first);
    throw new CliError(`'${first}' is not an airship command`, {
      exitCode: EXIT.unknownCommand,
      hint: numeric
        ? `Did you mean \`airship --target ${first}\`?`
        : (didYouMean(first, Object.keys(SUBCOMMANDS), "airship ") ??
          "Run `airship --help` to see the commands."),
    });
  }

  await runCommand(serve, {
    rawArgs: rawArgs.length > 0 ? rawArgs : await wizardArgs(),
  });
}

const argv = process.argv.slice(2);
// Read off the raw argv rather than the parsed settings: this has to be known
// before parsing, which is itself something that can fail.
const debug = argv.includes("--debug") || Boolean(process.env.AIRSHIP_DEBUG);
// Set before anything can fail, so an error raised during parsing is styled the
// same as one raised after. Each command re-derives it once it knows --json.
setColorEnabled(shouldColor({ json: argv.includes("--json") }));

/*
 * Every git invocation that failed, in full.
 *
 * The result objects carry one line each, which is what a toast can show. This
 * is the other half: the argv, the exit status and the whole of stderr, for the
 * case where the one line is not enough. stderr rather than stdout, so `--json`
 * stays parseable, and `AIRSHIP_DEBUG=1` works without changing how the daemon
 * is launched — which matters when the person who needs the trace is not the
 * person who knows the flags.
 */
if (debug) {
  onGitFailure((failure) => {
    const argvText = [failure.bin, ...failure.args].join(" ");
    const status = failure.errno ?? `exit ${failure.code}`;
    const detail = [failure.stderr, failure.stdout]
      .map((part) => part.trimEnd())
      .filter(Boolean)
      .join("\n");
    process.stderr.write(
      style.dim(
        `  ${argvText}\n    ${status}${failure.cwd ? ` in ${failure.cwd}` : ""}\n${detail ? `${detail}\n` : ""}`
      )
    );
  });
}

main(argv).catch((err: unknown) => {
  process.exit(reportError(err, { debug }));
});
