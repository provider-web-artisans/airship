/**
 * Airship inside the DeepSeek Harness — the host half.
 *
 * Three tools and one route. `airship_open` puts the visual editor in front of
 * a dev server the user is already running (or starts one with `--exec`, the
 * CLI's own contract, so the editor and the server die together), and answers
 * with the editor URL. `airship_status` reports what is running, `airship_close`
 * stops it. `POST /airship/open` is the same open, for a person: the client
 * half's Airship page calls it from a button, so the editor can be started
 * without a model deciding to call the tool — and always attached to the
 * session the person is looking at.
 *
 * The plugin is deliberately dependency-free: plain Node ESM that only touches
 * the `ctx` it is handed and `node:child_process`. A bundle that imports the
 * harness's own packages has to be installed where those resolve, and this one
 * does not — which is what makes it a two-file bundle rather than a build.
 *
 * Where the editor is *shown* is the client half's business, not this one's:
 * this half's job ends at a URL.
 */
import { spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";

/**
 * How long a spawn gets to print its banner. Airship boots its server and, with
 * `--exec`, waits for the dev server to come up first, so this is generous
 * enough to cover a cold Vite start and short enough that a port that is
 * already taken does not look like a hang.
 */
const START_TIMEOUT_MS = 60_000;
/** How long a child gets to exit on SIGTERM before it is killed outright. */
const STOP_GRACE_MS = 5000;

/** One supervised editor, keyed by the dev-server port it points at. */
const runs = new Map();

/**
 * Spawns in flight, keyed the same way.
 *
 * A second caller for a port that is already starting waits on the first spawn
 * instead of starting its own: two sessions can ask at the same moment, and two
 * editors on one port is the one outcome the per-port key exists to prevent.
 */
const starting = new Map();

/**
 * Children spawned but not yet in `runs` — waiting on their banner. Tracked
 * so unloading the plugin can kill them too: a child that published its run
 * a moment after cleanup would otherwise outlive the plugin.
 */
const pending = new Set();

/** Set once the plugin is unloaded; nothing may start after it. */
let disposed = false;

/** The binary to run: `airship` on PATH unless the environment says otherwise. */
function binary() {
  return process.env.AIRSHIP_BIN ?? "airship";
}

/**
 * Spawn Airship with these arguments. A binary that is a script — a
 * checkout's `dist/index.js`, or the tests' fixtures — runs under this Node:
 * only POSIX executes a script by its shebang, and Windows would refuse it.
 * A bare name, or a `.cmd` shim, needs no help.
 */
function spawnAirship(args, options) {
  const named = binary();
  return SCRIPT_BINARY.test(named)
    ? spawn(process.execPath, [named, ...args], options)
    : spawn(named, args, options);
}

/** A binary that is a script rather than an executable. */
const SCRIPT_BINARY = /\.(?:mjs|cjs|js)$/i;

/**
 * The editor URL out of whatever a child has printed so far.
 *
 * Airship's `--json` banner is one pretty-printed object, so the buffer becomes
 * parseable exactly when the banner is complete — which is the signal to stop
 * waiting rather than a length or a newline count.
 *
 * @param text - everything the child has written to stdout.
 * @returns the URL, or null while the banner is still incomplete.
 */
export function editorUrlOf(text) {
  return bannerOf(text)?.url ?? null;
}

/**
 * The banner itself, once it is complete: the URL, and the surface Airship
 * launched with (`canvas` or `inline`) so the row can ask for that one.
 *
 * @param text - everything the child has written to stdout.
 * @returns the banner, or null while it is incomplete or names no URL.
 */
export function bannerOf(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const banner = JSON.parse(trimmed);
    if (typeof banner?.url !== "string") {
      return null;
    }
    return {
      mode: banner.mode === "inline" ? "inline" : "canvas",
      url: banner.url,
    };
  } catch {
    return null;
  }
}

/**
 * Whether `port` is worth trying: a whole number inside the TCP range.
 *
 * Model arguments arrive as data, so a string `"3000"` is accepted and anything
 * else is refused here rather than becoming an exec argument.
 *
 * @param value - the argument as it arrived.
 * @returns the port, or null when it is not one.
 */
export function asPort(value) {
  const port = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * The running harness this editor should drive, when there is one.
 *
 * Airship's panel drives whatever it is pointed at. Pointed at nothing, it
 * spawns a child `dsh` per turn — a second session, in a second conversation,
 * next to the chat the person is already reading. Pointed here, its prompt
 * drives the session that called the tool, and the harness keeps governing the
 * turn the way it governs every other one.
 *
 * The flags come from surfaces the host already publishes: the session is the
 * calling agent's own id, the origin is the web server the person is looking
 * at, and the credentials are read from `DSH_HOME` by the CLI on the far side.
 *
 * @param ctx - the plugin context, for the host's own web server.
 * @param exec - the tool-run context the registry hands the tool.
 * @param agent - the agent the caller asked for, if any.
 * @returns the attach target, or undefined when this call cannot be attached.
 */
function attachTarget(ctx, exec, agent) {
  return attachTargetFor(ctx, exec?.agent?.id, agent);
}

/**
 * `attachTarget` for a session named outright — what the route has, since a
 * request from a button carries no tool-run context.
 *
 * @param ctx - the plugin context, for the host's own web server.
 * @param sessionId - the session the editor should drive.
 * @param agent - the agent the caller asked for, if any.
 * @returns the attach target, or undefined when it cannot be attached.
 */
function attachTargetFor(ctx, sessionId, agent) {
  if (agent !== undefined && agent !== "dsh") {
    return;
  }
  const port = ctx.get?.("webServer")?.port;
  if (typeof sessionId !== "string" || !Number.isInteger(port) || port <= 0) {
    return;
  }
  return {
    home: process.env.DSH_HOME,
    sessionId,
    url: `http://127.0.0.1:${String(port)}`,
  };
}

/** Kill a run's child and forget it. */
async function stop(run) {
  runs.delete(run.port);
  if (run.child.exitCode !== null || run.child.signalCode !== null) {
    return;
  }
  run.child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.child.kill("SIGKILL");
      resolve();
    }, STOP_GRACE_MS);
    run.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Spawn Airship and wait for the banner that says where the editor is. */
/** How long `airship inspect` gets: it probes a handful of ports at 400ms each. */
const INSPECT_TIMEOUT_MS = 15_000;

/**
 * What a launch in `cwd` would decide, from the CLI's own detection.
 *
 * `airship inspect --json` is the same `candidatePorts` and probe that `serve`
 * runs when `--target` is omitted, asked ahead of time — so a page can show
 * the guess and a caller can leave the port out, without this plugin carrying
 * a copy of the detection that would drift from the CLI's.
 *
 * @param cwd - the project root.
 * @returns the inspection, or rejects with the CLI's own words.
 */
export function inspect(cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnAirship(["inspect", "--json", "--cwd", cwd], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`could not run ${binary()}: ${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${binary()} inspect did not answer in time`));
    }, INSPECT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${binary()}: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join("\n");
        reject(
          new Error(
            `${binary()} inspect exited with ${String(code)}${tail ? `\n${tail}` : ""}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`${binary()} inspect printed no JSON`));
      }
    });
  });
}

/**
 * The port and start command a launch should use when the caller named only
 * some of them — the same choice `serve` makes, taken here so the answer can
 * be reported and so the launch is keyed by a real port.
 *
 * With a command in hand the server is about to be started, so the best
 * guess is right even though nothing answers there yet. Without one, a port
 * that answers is what the caller means; and when none does but the project
 * says how to start its dev server, that is the friendliest thing to do.
 *
 * @param inspection - what `inspect` reported.
 * @param asked - the port and command the caller gave, either optional.
 * @returns the port and command to launch with, or a reason there is none.
 */
export function resolveLaunch(inspection, asked) {
  const ports = Array.isArray(inspection?.ports) ? inspection.ports : [];
  const command = asked.command ?? inspection?.config?.exec;
  if (asked.port !== undefined) {
    return { command, port: asked.port };
  }
  const pinned = inspection?.config?.target;
  if (Number.isInteger(pinned) && pinned > 0) {
    return { command, port: pinned };
  }
  const [first] = ports;
  if (command) {
    return first
      ? { command, port: first.port, reason: first.reason }
      : { error: "could not work out which port the dev server will use" };
  }
  const live = ports.find((candidate) => candidate.listening);
  if (live) {
    return { port: live.port, reason: live.reason };
  }
  const startCommand = inspection?.startCommand;
  if (first && startCommand) {
    return { command: startCommand, port: first.port, reason: first.reason };
  }
  return {
    error:
      "no dev server is running and the project has no dev script to start one; pass a port or a command",
  };
}

function start({ port, command, agent, cwd, attach, mode }) {
  return new Promise((resolve, reject) => {
    const args = ["--target", String(port), "--json"];
    if (command) {
      args.push("--exec", command);
    }
    // Named on the command line, not only as the child's working directory:
    // the CLI reads a `cwd` from `airship.config.json` and the environment,
    // and only an explicit flag outranks those.
    if (cwd) {
      args.push("--cwd", cwd);
    }
    if (mode) {
      args.push("--mode", mode);
    }
    if (agent) {
      args.push("--agent", agent);
    }
    // The editor drives the harness that called the tool, so its panel is this
    // conversation rather than a second one in a session of its own.
    if (attach) {
      args.push("--dsh-url", attach.url, "--dsh-session", attach.sessionId);
      if (attach.home) {
        args.push("--dsh-home", attach.home);
      }
    }

    let child;
    try {
      child = spawnAirship(args, {
        cwd: cwd ?? process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`could not run ${binary()}: ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const run = {
      child,
      cwd,
      port,
      sessionId: attach?.sessionId,
      startedAt: Date.now(),
    };
    pending.add(run);

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pending.delete(run);
      if (error) {
        child.kill("SIGTERM");
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(tail ? new Error(`${error.message}\n${tail}`) : error);
        return;
      }
      if (disposed) {
        // The plugin went away while the banner was pending: the run must
        // not be published to a map nobody will clean again.
        child.kill("SIGTERM");
        reject(new Error("the Airship plugin was unloaded while starting"));
        return;
      }
      runs.set(port, run);
      resolve(run);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `${binary()} printed no editor URL within ${START_TIMEOUT_MS / 1000}s`
        )
      );
    }, START_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const banner = bannerOf(stdout);
      if (banner) {
        run.url = banner.url;
        run.mode = banner.mode;
        finish(null);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (error) => {
      finish(new Error(`could not run ${binary()}: ${error.message}`));
    });
    child.on("exit", (code) => {
      // An exit before the banner is a failure; after it, the editor is simply
      // gone, and the next `status` is where that shows up.
      if (!settled) {
        finish(
          new Error(
            `${binary()} exited with ${code} before printing an editor URL`
          )
        );
        return;
      }
      runs.delete(port);
    });
  });
}

/**
 * The editor for one dev-server port: the one already running, the one
 * already coming up, or a fresh spawn. The tool and the route both end here.
 *
 * @param options - what `start` takes.
 * @returns the run, once its banner has named the editor URL.
 */
async function open(options) {
  if (disposed) {
    throw new Error("the Airship plugin has been unloaded");
  }
  const { port } = options;
  const existing = runs.get(port);
  if (existing?.url) {
    return sameEditor(existing, options);
  }
  // Already coming up: wait for that spawn rather than starting a second.
  const inFlight = starting.get(port);
  if (inFlight) {
    return sameEditor(await inFlight, options);
  }
  const spawning = start(options).finally(() => starting.delete(port));
  starting.set(port, spawning);
  return await spawning;
}

/**
 * An error the route can answer with a status of its own.
 *
 * @param status - the HTTP status the route should send.
 * @param message - the reason, in the user's terms.
 */
function conflict(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * The editor already on a port, if it is the one the caller means.
 *
 * A port is the key, but the editor on it drives one session in one project.
 * Handing session B the editor that drives session A would answer B's click
 * with a panel that edits A's conversation — so reuse is only for the same
 * session and directory, and anything else is a conflict the caller resolves
 * by closing the editor or picking another port.
 */
function sameEditor(run, options) {
  const wantSession = options.attach?.sessionId;
  const wantCwd = options.cwd;
  const sessionDiffers =
    wantSession !== undefined && run.sessionId !== wantSession;
  const cwdDiffers =
    wantCwd !== undefined && run.cwd !== undefined && run.cwd !== wantCwd;
  if (sessionDiffers || cwdDiffers) {
    throw conflict(
      409,
      `port ${String(run.port)} already has an Airship editor for ${
        run.sessionId ? `session ${run.sessionId}` : "another caller"
      }${run.cwd ? ` in ${run.cwd}` : ""}; close it (airship_close) or use another port`
    );
  }
  return run;
}

/** The surface a caller asked for, or undefined for "the CLI's default". */
function asMode(value) {
  return value === "canvas" || value === "inline" ? value : undefined;
}

/**
 * The port and command to launch with, detecting whatever the caller left out.
 *
 * Nothing is spawned for detection when the port was given: the caller
 * already decided, and `inspect` would only cost a second.
 */
async function launchFor(cwd, asked) {
  if (asked.port !== undefined) {
    return asked;
  }
  const inspection = await inspect(cwd);
  const launch = resolveLaunch(inspection, asked);
  if (launch.error) {
    throw conflict(422, launch.error);
  }
  return launch;
}

/** A run, in the shape the tool answers with. */
function described(run) {
  return {
    cwd: run.cwd,
    mode: run.mode ?? "canvas",
    pid: run.child.pid ?? 0,
    port: run.port,
    sessionId: run.sessionId,
    url: run.url,
  };
}

export const name = "airship";
export const inject = ["tools"];

export function apply(ctx) {
  // Children outlive a tool call by design — the editor is for the person, not
  // for the turn — so unloading the plugin is the only thing that stops them.
  disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    const started = [...runs.values(), ...pending];
    runs.clear();
    pending.clear();
    starting.clear();
    for (const run of started) {
      run.child.kill("SIGTERM");
    }
  });

  ctx.tools.register({
    description:
      "Open Airship, the visual editor for the running app, against a dev server. Leave `port` out and Airship works it out from the project: a dev server already answering wins, otherwise the project's own dev script is started (and stopped when the editor closes). Pass `port` or `command` only to override that. Returns the editor URL; the user sees the editor in the sidebar's Browser tab.",
    async execute(args, exec) {
      const asked = asPort(args?.port);
      if (args?.port !== undefined && asked === null) {
        throw new Error("airship_open's `port` must be 1-65535 when given.");
      }
      const agent = typeof args?.agent === "string" ? args.agent : undefined;
      const cwd = typeof args?.cwd === "string" ? args.cwd : undefined;
      const launch = await launchFor(cwd ?? process.cwd(), {
        command: typeof args?.command === "string" ? args.command : undefined,
        port: asked ?? undefined,
      });
      const run = await open({
        agent,
        attach: attachTarget(ctx, exec, agent),
        command: launch.command,
        cwd,
        mode: asMode(args?.mode) ?? "inline",
        port: launch.port,
      });
      return described(run);
    },
    name: "airship_open",
    output: {
      // The mode is spelled out in the text on purpose: the row reads the
      // settled result's text, and it is how the row knows which surface to
      // ask the Browser tab for.
      render: (_args, value) => [
        {
          text: `Airship is serving the visual editor (${value.mode} mode) for the dev server on port ${value.port} at ${value.url} — open it in the sidebar's Browser tab.`,
          type: "text",
        },
      ],
      schema: {
        properties: {
          mode: { enum: ["canvas", "inline"], type: "string" },
          pid: { type: "number" },
          port: { type: "number" },
          url: { type: "string" },
        },
        required: ["url", "port", "pid", "mode"],
        type: "object",
      },
    },
    parameters: {
      properties: {
        agent: {
          description:
            'Which coding agent Airship drives from its own prompt box. Defaults to its own choice; "dsh" attaches where Airship supports it.',
          type: "string",
        },
        command: {
          description:
            'Command that starts the dev server, for example "pnpm dev". Omit it when one is already running.',
          type: "string",
        },
        cwd: {
          description:
            "Project directory the editor serves. Defaults to the session's working directory.",
          type: "string",
        },
        mode: {
          description:
            'Editor surface: "inline" lays the editor over the page itself; "canvas" puts the app on a pannable canvas with one live frame per device size. Defaults to inline.',
          enum: ["canvas", "inline"],
          type: "string",
        },
        port: {
          description:
            "Port the dev server listens on. Omit it to let Airship detect it from the project; Airship puts its editor on the next free port above it.",
          type: "number",
        },
      },
      required: [],
      type: "object",
    },
  });

  ctx.tools.register({
    description:
      "List the Airship editors this session has started, with their dev-server port and URL.",
    execute() {
      return { runs: [...runs.values()].map(described) };
    },
    name: "airship_status",
    output: {
      render: (_args, value) =>
        value.runs.length === 0
          ? [{ text: "No Airship editor is running.", type: "text" }]
          : [
              {
                text: value.runs
                  .map(
                    (run) => `port ${run.port} → ${run.url} (pid ${run.pid})`
                  )
                  .join("\n"),
                type: "text",
              },
            ],
      schema: {
        properties: {
          runs: {
            items: {
              properties: {
                cwd: { type: "string" },
                mode: { type: "string" },
                pid: { type: "number" },
                port: { type: "number" },
                sessionId: { type: "string" },
                url: { type: "string" },
              },
              required: ["url", "port", "pid"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["runs"],
        type: "object",
      },
    },
    parameters: { properties: {}, type: "object" },
  });

  ctx.tools.register({
    description:
      "Stop an Airship editor. Omit `port` to stop every editor this session started. A dev server Airship started itself is stopped with it.",
    async execute(args) {
      const wanted = args?.port === undefined ? null : asPort(args.port);
      const targets = [...runs.values()].filter(
        (run) => wanted === null || run.port === wanted
      );
      await Promise.all(targets.map((run) => stop(run)));
      return { closed: targets.length };
    },
    name: "airship_close",
    output: {
      render: (_args, value) => [
        {
          text:
            value.closed === 1
              ? "Stopped 1 Airship editor."
              : `Stopped ${value.closed} Airship editors.`,
          type: "text",
        },
      ],
      schema: {
        properties: { closed: { type: "number" } },
        required: ["closed"],
        type: "object",
      },
    },
    parameters: {
      properties: {
        port: {
          description:
            "Dev-server port of the editor to stop. Omit for all of them.",
          type: "number",
        },
      },
      type: "object",
    },
  });

  // The button's path. Registered only where the composition has a web server
  // and a connection to vouch for its callers — a bare ACP profile has neither,
  // and the tools above work there without it.
  ctx.inject?.(["webServer", "connection"], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          handler: (req, res) => openRoute(host, req, res),
          kind: "exact",
          path: OPEN_ROUTE,
        }),
      `airship: POST ${OPEN_ROUTE}`
    );
    host.effect(
      () =>
        host.webServer.register({
          handler: (req, res) => inspectRoute(host, req, res),
          kind: "exact",
          path: INSPECT_ROUTE,
        }),
      `airship: GET ${INSPECT_ROUTE}`
    );
    host.effect(
      () =>
        host.webServer.register({
          handler: (req, res) => statusRoute(host, req, res),
          kind: "exact",
          path: STATUS_ROUTE,
        }),
      `airship: GET ${STATUS_ROUTE}`
    );
    host.effect(
      () =>
        host.webServer.register({
          handler: (req, res) => closeRoute(host, req, res),
          kind: "exact",
          path: CLOSE_ROUTE,
        }),
      `airship: POST ${CLOSE_ROUTE}`
    );
    host.effect(
      () =>
        host.webServer.register({
          handler: (req, res) => stopRoute(host, req, res),
          kind: "exact",
          path: STOP_ROUTE,
        }),
      `airship: POST ${STOP_ROUTE}`
    );
  });
}

/** The route the page reads to list what is running. */
export const STATUS_ROUTE = "/airship/status";
/** The route the page's Close control POSTs to. */
export const CLOSE_ROUTE = "/airship/close";

/** `GET /airship/status`: every editor this plugin supervises. */
export function statusRoute(ctx, req, res) {
  if (refused(ctx, req, res)) {
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  sendJson(res, 200, { runs: [...runs.values()].map(described) });
}

/**
 * `POST /airship/close` with `{ port }`: stop that editor, and the dev server
 * it started, if it started one. A port nothing runs on is not an error —
 * the person's intent is met either way.
 */
export async function closeRoute(ctx, req, res) {
  if (refused(ctx, req, res)) {
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    return;
  }
  let text;
  try {
    text = await readBoundedBody(req);
  } catch {
    sendJson(res, 400, { message: "request body unreadable" });
    return;
  }
  let port = null;
  try {
    port = asPort(JSON.parse(text ?? "").port);
  } catch {
    port = null;
  }
  if (port === null) {
    sendJson(res, 400, { message: 'request body must be JSON with a "port"' });
    return;
  }
  const run = runs.get(port);
  if (run) {
    await stop(run);
  }
  sendJson(res, 200, { closed: Boolean(run), port });
}

/** The route the page's Stop control POSTs to: the site's own dev server. */
export const STOP_ROUTE = "/airship/stop";
/** How often a process signalled is looked at, while it gets its grace. */
const STOP_POLL_MS = 100;

/**
 * Run `lsof` and hand back what it printed. It exits 1 when nothing matched,
 * which is an answer, not a failure; only a machine without it fails.
 */
function lsof(args) {
  return new Promise((resolve, reject) => {
    let out = "";
    let child;
    try {
      child = spawn("lsof", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.once("error", (error) =>
      reject(
        error?.code === "ENOENT"
          ? new Error("lsof is not available on this machine")
          : error
      )
    );
    child.once("close", () => resolve(out));
  });
}

/** The PIDs `lsof -t` printed, one per line. */
const parsePids = (out) =>
  out
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

/** The path in `lsof -Fn` output: the line that starts with `n`. */
const parseCwd = (out) => {
  const line = out.split("\n").find((entry) => entry.startsWith("n/"));
  return line ? line.slice(1) : null;
};

/**
 * What runs on a port, and how it ends. `lsof` answers the same on macOS and
 * Linux, for the listeners and for a process's working directory, which is
 * the guard: only a process working inside the project is the project's dev
 * server. Replaceable, so the tests need no real listener.
 */
const processTools = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  cwdOf: (pid) =>
    lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).then(parseCwd),
  kill: (pid, signal) => process.kill(pid, signal),
  listeners: (port) =>
    lsof(["-nP", "-t", `-iTCP:${String(port)}`, "-sTCP:LISTEN"]).then(
      parsePids
    ),
};

/** True when `dir` is `root` or inside it. */
function within(dir, root) {
  const rel = relative(root, dir);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

/** Send one signal to each; one already gone is no failure. */
function signalEach(pids, signalName, tools) {
  for (const pid of pids) {
    try {
      tools.kill(pid, signalName);
    } catch {
      // Already gone.
    }
  }
}

/** Settles with whoever is still alive when they have all gone, or the grace has run out. */
function survivors(pids, tools) {
  const deadline = Date.now() + STOP_GRACE_MS;
  return new Promise((resolve) => {
    const look = () => {
      const left = pids.filter((pid) => tools.alive(pid));
      if (left.length === 0 || Date.now() >= deadline) {
        resolve(left);
        return;
      }
      setTimeout(look, STOP_POLL_MS);
    };
    look();
  });
}

/** SIGTERM them all, give them the grace, then SIGKILL whoever is left. */
async function terminate(pids, tools) {
  signalEach(pids, "SIGTERM", tools);
  signalEach(await survivors(pids, tools), "SIGKILL", tools);
}

/**
 * Stop the site on a port: the editor there first, if there is one (it takes
 * the dev server it started with it), then whatever still listens on the
 * port and works inside the project — a dev server the person started
 * themselves, or one that hung. A listener working elsewhere is not the
 * project's and is left alone, and said so.
 *
 * @param port - the dev server's port.
 * @param cwd - the project the session is in.
 * @param tools - the process listing and signalling, `processTools` unless testing.
 * @returns what was closed, stopped and kept, and the problem if the port could not be read.
 */
export async function stopSite(port, cwd, tools = processTools) {
  const run = runs.get(port);
  if (run) {
    await stop(run);
  }
  const outcome = { closed: Boolean(run), kept: [], port, stopped: [] };
  let pids;
  try {
    pids = await tools.listeners(port);
  } catch (error) {
    outcome.problem = error instanceof Error ? error.message : String(error);
    return outcome;
  }
  const dirs = await Promise.all(
    pids.map((pid) =>
      pid === process.pid ? null : tools.cwdOf(pid).catch(() => null)
    )
  );
  for (const [index, pid] of pids.entries()) {
    const dir = dirs[index];
    if (dir !== null && within(dir, cwd)) {
      outcome.stopped.push(pid);
    } else {
      outcome.kept.push(pid);
    }
  }
  await terminate(outcome.stopped, tools);
  return outcome;
}

/** The status and words for a stop's outcome. */
function stopVerdict(outcome) {
  if (outcome.stopped.length > 0 || outcome.closed) {
    return { status: 200 };
  }
  if (outcome.problem) {
    return { message: outcome.problem, status: 502 };
  }
  if (outcome.kept.length > 0) {
    return {
      message: `Port ${String(outcome.port)} is used by a program outside this project (pid ${outcome.kept.join(", ")}); it was left alone.`,
      status: 409,
    };
  }
  return { status: 200 };
}

/** `{ sessionId, port }` from a stop body, or null. */
function parseStopBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const port = asPort(body?.port);
  const sessionId = body?.sessionId;
  return port !== null && typeof sessionId === "string" && sessionId !== ""
    ? { port, sessionId }
    : null;
}

/**
 * `POST /airship/stop` with `{ sessionId, port }`: end the site's dev server
 * on that port, whoever started it, as long as it works inside the session's
 * project. The session names the project, from the session store rather than
 * the wire, so a page cannot aim this at another directory.
 */
export async function stopRoute(ctx, req, res) {
  if (refused(ctx, req, res)) {
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    return;
  }
  let text;
  try {
    text = await readBoundedBody(req);
  } catch {
    sendJson(res, 400, { message: "request body unreadable" });
    return;
  }
  const parsed = text === null ? null : parseStopBody(text);
  if (parsed === null) {
    sendJson(res, 400, {
      message: 'request body must be JSON with a "sessionId" and a "port"',
    });
    return;
  }
  const cwd = sessionDirectory(ctx, parsed.sessionId);
  if (!cwd) {
    sendJson(res, 404, {
      message: `session ${parsed.sessionId} is not open here, or has no working directory`,
    });
    return;
  }
  const outcome = await stopSite(parsed.port, cwd);
  const verdict = stopVerdict(outcome);
  sendJson(res, verdict.status, {
    ...outcome,
    ...(verdict.message ? { message: verdict.message } : {}),
  });
}

/** The route the client half's page POSTs to. */
export const OPEN_ROUTE = "/airship/open";
/** Open-route bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/** JSON response, `no-store`: a launch outcome is a live fact. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** The body, or null past the size cap. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Validate one open-route body at the wire.
 *
 * @param text - the raw body.
 * @returns the fields, or null when it is not what the page sends.
 */
export function parseOpenBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") {
    return null;
  }
  const port = asPort(body.port);
  if (body.port !== undefined && body.port !== null && port === null) {
    return null;
  }
  if (typeof body.sessionId !== "string" || !body.sessionId) {
    return null;
  }
  return {
    command:
      typeof body.command === "string" && body.command.trim()
        ? body.command.trim()
        : undefined,
    mode: asMode(body.mode),
    port: port ?? undefined,
    sessionId: body.sessionId,
    takeover: body.takeover === true,
  };
}

/**
 * The directory a live session was created in, or undefined.
 *
 * The session store answers only for live sessions, and a live session's
 * header carries the absolute directory it was created in. Nothing else is
 * good enough to start a dev server in: a session the host does not know, or
 * one without a directory, is refused rather than started in the host
 * process's own working directory.
 */
function sessionDirectory(ctx, sessionId) {
  const session = ctx.get?.("sessions")?.get?.(sessionId);
  const cwd = session?.header?.cwd;
  return session && typeof cwd === "string" && isAbsolute(cwd)
    ? cwd
    : undefined;
}

/** True when the request was refused; the response is already sent. */
function refused(ctx, req, res) {
  const rejection = ctx.connection?.requestRejection?.(req);
  if (rejection === undefined) {
    return false;
  }
  res.statusCode = rejection;
  res.end();
  return true;
}

/** The route the page reads before it offers the button. */
export const INSPECT_ROUTE = "/airship/inspect";

/**
 * `GET /airship/inspect?sessionId=…`: what a launch for that session would
 * decide — the project's name, its candidate ports and which answer, and the
 * command that would start its dev server. The page shows this and prefills
 * its fields from it, so the person confirms a guess rather than typing one.
 */
export async function inspectRoute(ctx, req, res) {
  if (refused(ctx, req, res)) {
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  const sessionId = new URL(
    req.url ?? "/",
    "http://localhost"
  ).searchParams.get("sessionId");
  if (!sessionId) {
    sendJson(res, 400, { message: "sessionId is required" });
    return;
  }
  const cwd = sessionDirectory(ctx, sessionId);
  if (!cwd) {
    sendJson(res, 404, {
      message: `session ${sessionId} is not open here, or has no working directory`,
    });
    return;
  }
  try {
    const inspection = await inspect(cwd);
    const launch = resolveLaunch(inspection, {});
    sendJson(res, 200, { ...inspection, launch });
  } catch (error) {
    sendJson(res, 502, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `POST /airship/open`: the tool's open, driven by a person.
 *
 * The request names the session the page is showing; the editor is attached
 * to it, and its project directory is that session's own — read from the
 * session store rather than trusted from the wire, so a page cannot point the
 * editor at an arbitrary directory. The caller is vouched for the same way
 * every other host route vouches: the connection service's own rejection.
 */
export async function openRoute(ctx, req, res) {
  if (refused(ctx, req, res)) {
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    return;
  }
  let text;
  try {
    text = await readBoundedBody(req);
  } catch {
    sendJson(res, 400, { message: "request body unreadable" });
    return;
  }
  if (text === null) {
    sendJson(res, 413, { message: "request body is too large" });
    return;
  }
  const parsed = parseOpenBody(text);
  if (parsed === null) {
    sendJson(res, 400, {
      message:
        'request body must be JSON with a "sessionId" and, if given, a dev-server "port" (1-65535)',
    });
    return;
  }
  if (disposed) {
    sendJson(res, 503, { message: "the Airship plugin has been unloaded" });
    return;
  }
  const cwd = sessionDirectory(ctx, parsed.sessionId);
  if (!cwd) {
    sendJson(res, 404, {
      message: `session ${parsed.sessionId} is not open here, or has no working directory`,
    });
    return;
  }
  const attach = attachTargetFor(ctx, parsed.sessionId, "dsh");
  if (!attach) {
    sendJson(res, 503, {
      message: "this host serves no web UI to attach the editor to",
    });
    return;
  }
  try {
    const launch = await launchFor(cwd, {
      command: parsed.command,
      port: parsed.port,
    });
    // Reattach: the person asked for the editor on this port to drive *this*
    // session, whatever it drove before. Stop it, then start over for us.
    const holder = runs.get(launch.port);
    if (parsed.takeover && holder && holder.sessionId !== parsed.sessionId) {
      await stop(holder);
    }
    const run = await open({
      // Pinned, so a project's `airship.config.json` naming another backend
      // cannot detach the editor from the session it was opened for.
      agent: "dsh",
      attach,
      command: launch.command,
      cwd,
      mode: parsed.mode ?? "inline",
      port: launch.port,
    });
    sendJson(res, 200, described(run));
  } catch (error) {
    sendJson(res, typeof error?.status === "number" ? error.status : 502, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
