/**
 * `POST /airship/open`, the button's path, exercised through the handler the
 * host half registers on the composition's web server.
 *
 * The web server, the connection and the session store are stubs: what is
 * pinned is the contract — who is refused, what a body must carry, that the
 * editor is attached to the session named and started in that session's own
 * directory — with the same banner fixture the tool tests spawn.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  apply,
  CLOSE_ROUTE,
  INSPECT_ROUTE,
  OPEN_ROUTE,
  parseOpenBody,
  resolveLaunch,
  STATUS_ROUTE,
  STOP_ROUTE,
  stopRoute,
  stopSite,
} from "../index.js";

const fixture = (name) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Mount with a web server that captures the route, and hand it back. */
function mount({ rejection, sessions = {} } = {}) {
  const routes = [];
  const tools = {};
  const disposers = [];
  const ctx = {
    connection: {
      requestRejection: () => rejection,
    },
    effect: (register) => {
      const dispose = register();
      if (typeof dispose === "function") {
        disposers.push(dispose);
      }
    },
    get: (name) => {
      if (name === "webServer") {
        return { port: 47_110 };
      }
      if (name === "sessions") {
        return { get: (id) => sessions[id] };
      }
    },
    inject: (_deps, callback) => callback(ctx),
    tools: {
      register: (definition) => {
        tools[definition.name] = definition;
        return () => undefined;
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => undefined;
      },
    },
  };
  apply(ctx);
  return { disposers, routes, tools };
}

/** A request the handler can read: method, headers, and a body to iterate. */
function request({ method = "POST", body = "", json = true, url } = {}) {
  return {
    url,
    [Symbol.asyncIterator]() {
      const chunks = body ? [Buffer.from(body)] : [];
      return {
        next: () =>
          Promise.resolve(
            chunks.length
              ? { done: false, value: chunks.shift() }
              : { done: true, value: undefined }
          ),
      };
    },
    headers: json ? { "content-type": "application/json" } : {},
    method,
    resume: () => undefined,
  };
}

/** A response that remembers what was sent. */
function response() {
  const res = {
    body: "",
    end: (chunk) => {
      res.body += chunk ?? "";
    },
    headers: {},
    setHeader: (name, value) => {
      res.headers[name] = value;
    },
    statusCode: 200,
  };
  return res;
}

async function withBinary(name, run) {
  const previous = process.env.AIRSHIP_BIN;
  process.env.AIRSHIP_BIN = fixture(name);
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.AIRSHIP_BIN;
    } else {
      process.env.AIRSHIP_BIN = previous;
    }
  }
}

async function argvOf(run) {
  const file = join(tmpdir(), `airship-route-argv-${String(Date.now())}.json`);
  const previous = process.env.AIRSHIP_ARGV_FILE;
  process.env.AIRSHIP_ARGV_FILE = file;
  try {
    await run();
    return JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(file, { force: true });
    if (previous === undefined) {
      delete process.env.AIRSHIP_ARGV_FILE;
    } else {
      process.env.AIRSHIP_ARGV_FILE = previous;
    }
  }
}

async function reset() {
  await mount().tools.airship_close.execute({});
}

after(reset);

describe("parseOpenBody", () => {
  it("needs a session, takes an optional port, and the rest when well-formed", () => {
    assert.equal(parseOpenBody("not json"), null);
    assert.equal(parseOpenBody(JSON.stringify({ port: 3000 })), null);
    assert.equal(
      parseOpenBody(JSON.stringify({ port: "nope", sessionId: "s" })),
      null,
      "a port that is given must be one"
    );
    assert.deepEqual(parseOpenBody(JSON.stringify({ sessionId: "s" })), {
      command: undefined,
      mode: undefined,
      port: undefined,
      sessionId: "s",
      takeover: false,
    });
    assert.deepEqual(
      parseOpenBody(
        JSON.stringify({
          command: " pnpm dev ",
          mode: "inline",
          port: "3000",
          sessionId: "s",
        })
      ),
      {
        command: "pnpm dev",
        mode: "inline",
        port: 3000,
        sessionId: "s",
        takeover: false,
      }
    );
  });
});

describe("resolveLaunch", () => {
  const listening = { listening: true, port: 3000, reason: "common" };
  const guess = { listening: false, port: 4321, reason: "astro" };

  it("keeps a port the caller gave, adding the config's exec", () => {
    assert.deepEqual(
      resolveLaunch({ config: { exec: "pnpm dev" }, ports: [] }, { port: 5 }),
      { command: "pnpm dev", port: 5 }
    );
  });

  it("takes a target the config pins", () => {
    assert.deepEqual(
      resolveLaunch({ config: { target: 3100 }, ports: [listening] }, {}),
      { command: undefined, port: 3100 }
    );
  });

  it("with a command, expects the best guess rather than what answers", () => {
    assert.deepEqual(
      resolveLaunch(
        { config: {}, ports: [guess, listening] },
        { command: "x" }
      ),
      { command: "x", port: 4321, reason: "astro" }
    );
  });

  it("without a command, attaches to the port that answers", () => {
    assert.deepEqual(
      resolveLaunch({ config: {}, ports: [guess, listening] }, {}),
      { port: 3000, reason: "common" }
    );
  });

  it("starts the dev script when nothing answers and there is one", () => {
    assert.deepEqual(
      resolveLaunch(
        { config: {}, ports: [guess], startCommand: "pnpm dev" },
        {}
      ),
      { command: "pnpm dev", port: 4321, reason: "astro" }
    );
  });

  it("explains itself when there is nothing to do", () => {
    assert.ok(resolveLaunch({ config: {}, ports: [guess] }, {}).error);
    assert.ok(resolveLaunch({ config: {}, ports: [] }, { command: "x" }).error);
  });
});

describe(`GET ${INSPECT_ROUTE}`, () => {
  it("answers what a launch for the session would decide", async () => {
    const { routes } = mount({
      sessions: { "session-20": { header: { cwd: tmpdir() } } },
    });
    const res = response();
    await withBinary("airship-inspect.mjs", () =>
      routes[1].handler(
        request({
          method: "GET",
          url: `${INSPECT_ROUTE}?sessionId=session-20`,
        }),
        res
      )
    );
    assert.equal(res.statusCode, 200, res.body);
    const value = JSON.parse(res.body);
    assert.equal(value.name, "fixture");
    assert.deepEqual(value.launch, {
      port: 3000,
      reason: "a common dev-server port",
    });
  });

  it("refuses without a session, and a session it does not have", async () => {
    const { routes } = mount({ sessions: {} });
    const none = response();
    await routes[1].handler(
      request({ method: "GET", url: INSPECT_ROUTE }),
      none
    );
    assert.equal(none.statusCode, 400);
    const ghost = response();
    await routes[1].handler(
      request({ method: "GET", url: `${INSPECT_ROUTE}?sessionId=ghost` }),
      ghost
    );
    assert.equal(ghost.statusCode, 404);
  });

  it("is refused by the connection like the open route", async () => {
    const { routes } = mount({ rejection: 401 });
    const res = response();
    await routes[1].handler(
      request({ method: "GET", url: `${INSPECT_ROUTE}?sessionId=s` }),
      res
    );
    assert.equal(res.statusCode, 401);
  });
});

describe(`POST ${OPEN_ROUTE}`, () => {
  it("is registered on the composition's web server", () => {
    const { routes } = mount();
    assert.deepEqual(
      routes.map((route) => [route.kind, route.path]),
      [
        ["exact", OPEN_ROUTE],
        ["exact", INSPECT_ROUTE],
        ["exact", STATUS_ROUTE],
        ["exact", CLOSE_ROUTE],
        ["exact", STOP_ROUTE],
      ]
    );
  });

  it("answers the connection's rejection before reading anything", async () => {
    const { routes } = mount({ rejection: 401 });
    const res = response();
    await routes[0].handler(request({ body: "{}" }), res);
    assert.equal(res.statusCode, 401);
  });

  it("only takes POST", async () => {
    const { routes } = mount();
    const res = response();
    await routes[0].handler(request({ method: "GET" }), res);
    assert.equal(res.statusCode, 405);
  });

  it("refuses a body that names no session, or a port that is not one", async () => {
    const { routes } = mount();
    const noSession = response();
    await routes[0].handler(
      request({ body: JSON.stringify({ port: 3000 }) }),
      noSession
    );
    assert.equal(noSession.statusCode, 400);
    assert.ok(
      JSON.parse(noSession.body).message.includes('"sessionId"'),
      noSession.body
    );
    const badPort = response();
    await routes[0].handler(
      request({ body: JSON.stringify({ port: 0, sessionId: "s" }) }),
      badPort
    );
    assert.equal(badPort.statusCode, 400);
  });

  it("works the port out from the project when the body names none", async () => {
    await reset();
    const { routes } = mount({
      sessions: { "session-21": { header: { cwd: tmpdir() } } },
    });
    const res = response();
    const argv = await withBinary("airship-inspect.mjs", () =>
      argvOf(() =>
        routes[0].handler(
          request({ body: JSON.stringify({ sessionId: "session-21" }) }),
          res
        )
      )
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).port, 3000);
    assert.deepEqual(argv.slice(0, 3), ["--target", "3000", "--json"]);
    await reset();
  });

  it("starts the editor attached to the named session, in its directory, and answers with it", async () => {
    await reset();
    const { routes } = mount({
      sessions: { "session-9": { header: { cwd: tmpdir() } } },
    });
    const res = response();
    const argv = await withBinary("airship-banner.mjs", () =>
      argvOf(() =>
        routes[0].handler(
          request({
            body: JSON.stringify({
              mode: "inline",
              port: 47_120,
              sessionId: "session-9",
            }),
          }),
          res
        )
      )
    );
    assert.equal(res.statusCode, 200, res.body);
    const value = JSON.parse(res.body);
    assert.equal(value.url, "http://localhost:47001");
    assert.equal(value.port, 47_120);
    assert.equal(value.mode, "canvas", "the fixture's banner names no mode");
    assert.deepEqual(argv, [
      "--target",
      "47120",
      "--json",
      "--cwd",
      tmpdir(),
      "--mode",
      "inline",
      "--agent",
      "dsh",
      "--dsh-url",
      "http://127.0.0.1:47110",
      "--dsh-session",
      "session-9",
    ]);
  });

  it("returns the editor already running on that port to the same session", async () => {
    const { routes, tools } = mount({
      sessions: { "session-9": { header: { cwd: tmpdir() } } },
    });
    const res = response();
    await routes[0].handler(
      request({
        body: JSON.stringify({ port: 47_120, sessionId: "session-9" }),
      }),
      res
    );
    assert.equal(res.statusCode, 200, res.body);
    const status = await tools.airship_status.execute({});
    assert.deepEqual(
      status.runs.map((run) => run.port),
      [47_120]
    );
  });

  it("refuses to hand another session the editor on that port", async () => {
    const { routes } = mount({
      sessions: { "session-10": { header: { cwd: tmpdir() } } },
    });
    const res = response();
    await routes[0].handler(
      request({
        body: JSON.stringify({ port: 47_120, sessionId: "session-10" }),
      }),
      res
    );
    assert.equal(res.statusCode, 409, res.body);
    assert.ok(JSON.parse(res.body).message.includes("session-9"), res.body);
    await reset();
  });

  it("refuses a session the host does not have open, before starting anything", async () => {
    const { routes } = mount({ sessions: {} });
    const res = response();
    await withBinary("airship-dies.mjs", () =>
      routes[0].handler(
        request({
          body: JSON.stringify({ port: 47_130, sessionId: "ghost" }),
        }),
        res
      )
    );
    assert.equal(res.statusCode, 404, res.body);
  });

  it("refuses a session whose directory is not absolute", async () => {
    const { routes } = mount({
      sessions: { "session-11": { header: { cwd: "relative/dir" } } },
    });
    const res = response();
    await routes[0].handler(
      request({
        body: JSON.stringify({ port: 47_131, sessionId: "session-11" }),
      }),
      res
    );
    assert.equal(res.statusCode, 404, res.body);
  });

  it("rejects before reading the body", async () => {
    const { routes } = mount({ rejection: 403 });
    let read = false;
    const req = request({ body: "{}" });
    const iterate = req[Symbol.asyncIterator];
    req[Symbol.asyncIterator] = () => {
      read = true;
      return iterate.call(req);
    };
    const res = response();
    await routes[0].handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(read, false);
  });

  it("kills a child still waiting on its banner when the plugin unloads", async () => {
    await reset();
    const { disposers, routes } = mount({
      sessions: { "session-12": { header: { cwd: tmpdir() } } },
    });
    const res = response();
    const handled = withBinary("airship-banner.mjs", () =>
      routes[0].handler(
        request({
          body: JSON.stringify({ port: 47_140, sessionId: "session-12" }),
        }),
        res
      )
    );
    // The spawn is synchronous; the banner is not. Unload in between.
    for (const dispose of disposers) {
      dispose();
    }
    await handled;
    assert.equal(res.statusCode, 503, res.body);
    // A fresh mount sees nothing left behind.
    const status = await mount().tools.airship_status.execute({});
    assert.deepEqual(status.runs, []);
  });
});

describe(`${STATUS_ROUTE}, ${CLOSE_ROUTE} and reattaching`, () => {
  const sessions = {
    "session-30": { header: { cwd: tmpdir() } },
    "session-31": { header: { cwd: tmpdir() } },
  };

  it("lists what runs, with the session each editor drives", async () => {
    await reset();
    const { routes } = mount({ sessions });
    await withBinary("airship-banner.mjs", () =>
      routes[0].handler(
        request({
          body: JSON.stringify({ port: 47_150, sessionId: "session-30" }),
        }),
        response()
      )
    );
    const res = response();
    await routes[2].handler(request({ method: "GET" }), res);
    assert.equal(res.statusCode, 200);
    const { runs } = JSON.parse(res.body);
    assert.deepEqual(
      runs.map((run) => [run.port, run.sessionId, run.cwd]),
      [[47_150, "session-30", tmpdir()]]
    );
  });

  it("refuses to hand another session that editor, unless it takes over", async () => {
    const { routes } = mount({ sessions });
    const refused = response();
    await routes[0].handler(
      request({
        body: JSON.stringify({ port: 47_150, sessionId: "session-31" }),
      }),
      refused
    );
    assert.equal(refused.statusCode, 409);

    const taken = response();
    await withBinary("airship-banner.mjs", () =>
      routes[0].handler(
        request({
          body: JSON.stringify({
            port: 47_150,
            sessionId: "session-31",
            takeover: true,
          }),
        }),
        taken
      )
    );
    assert.equal(taken.statusCode, 200, taken.body);
    assert.equal(JSON.parse(taken.body).sessionId, "session-31");
    const res = response();
    await routes[2].handler(request({ method: "GET" }), res);
    assert.deepEqual(
      JSON.parse(res.body).runs.map((run) => run.sessionId),
      ["session-31"]
    );
  });

  it("closes one editor by port, and says when there was none", async () => {
    const { routes } = mount({ sessions });
    const closed = response();
    await routes[3].handler(
      request({ body: JSON.stringify({ port: 47_150 }) }),
      closed
    );
    assert.deepEqual(JSON.parse(closed.body), { closed: true, port: 47_150 });
    const again = response();
    await routes[3].handler(
      request({ body: JSON.stringify({ port: 47_150 }) }),
      again
    );
    assert.deepEqual(JSON.parse(again.body), { closed: false, port: 47_150 });
    const res = response();
    await routes[2].handler(request({ method: "GET" }), res);
    assert.deepEqual(JSON.parse(res.body).runs, []);
  });

  it("needs a port to close, and the connection's blessing", async () => {
    const { routes } = mount({ sessions });
    const bad = response();
    await routes[3].handler(request({ body: "{}" }), bad);
    assert.equal(bad.statusCode, 400);
    const { routes: guarded } = mount({ rejection: 401, sessions });
    const res = response();
    await guarded[2].handler(request({ method: "GET" }), res);
    assert.equal(res.statusCode, 401);
  });
});

/**
 * Process tools that remember what they were asked, for a port with the
 * given listeners: `{ pid: cwd }`. A process signalled is gone at once.
 */
function fakeProcesses(listening, { listingFails = false } = {}) {
  const signals = [];
  const gone = new Set();
  return {
    signals,
    tools: {
      alive: (pid) => !gone.has(pid),
      cwdOf: (pid) => Promise.resolve(listening[pid] ?? null),
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        gone.add(pid);
      },
      listeners: () =>
        listingFails
          ? Promise.reject(new Error("lsof is not available on this machine"))
          : Promise.resolve(Object.keys(listening).map(Number)),
    },
  };
}

describe("stopSite", () => {
  const project = "/work/site";

  it("ends the listeners working inside the project, and keeps the others", async () => {
    const { signals, tools } = fakeProcesses({
      401: "/work/site",
      402: "/work/site/apps/web",
      403: "/work/other",
      404: null,
    });
    const outcome = await stopSite(4321, project, tools);
    assert.deepEqual(outcome, {
      closed: false,
      kept: [403, 404],
      port: 4321,
      stopped: [401, 402],
    });
    assert.deepEqual(signals, [
      [401, "SIGTERM"],
      [402, "SIGTERM"],
    ]);
  });

  it("never signals the host itself, even working in the project", async () => {
    const { signals, tools } = fakeProcesses({ [process.pid]: project });
    const outcome = await stopSite(4321, project, tools);
    assert.deepEqual(outcome.kept, [process.pid]);
    assert.deepEqual(signals, []);
  });

  it("says when the port could not be read, instead of guessing", async () => {
    const { tools } = fakeProcesses({}, { listingFails: true });
    const outcome = await stopSite(4321, project, tools);
    assert.equal(outcome.problem, "lsof is not available on this machine");
    assert.deepEqual(outcome.stopped, []);
  });
});

describe(`POST ${STOP_ROUTE}`, () => {
  const sessions = {
    "session-1": { header: { cwd: "/work/site" } },
  };
  const ctxFor = (rejection) => ({
    connection: { requestRejection: () => rejection },
    get: (name) =>
      name === "sessions" ? { get: (id) => sessions[id] } : undefined,
  });

  it("needs a session and a port, and only takes POST", async () => {
    const bad = response();
    await stopRoute(ctxFor(undefined), request({ body: "{}" }), bad);
    assert.equal(bad.statusCode, 400);
    const noPort = response();
    await stopRoute(
      ctxFor(undefined),
      request({ body: JSON.stringify({ sessionId: "session-1" }) }),
      noPort
    );
    assert.equal(noPort.statusCode, 400);
    const get = response();
    await stopRoute(ctxFor(undefined), request({ method: "GET" }), get);
    assert.equal(get.statusCode, 405);
    const refused = response();
    await stopRoute(ctxFor(401), request({ body: "{}" }), refused);
    assert.equal(refused.statusCode, 401);
  });

  it("refuses a session the host does not have open", async () => {
    const res = response();
    await stopRoute(
      ctxFor(undefined),
      request({ body: JSON.stringify({ port: 4321, sessionId: "nope" }) }),
      res
    );
    assert.equal(res.statusCode, 404);
  });
});
