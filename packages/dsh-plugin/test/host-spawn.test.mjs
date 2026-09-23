/**
 * The host half's supervision, exercised through the tools it registers.
 *
 * `apply` is called with a stub context, so the tools are the same objects the
 * harness would call. `AIRSHIP_BIN` then points at a fixture instead of the real
 * CLI — which is the whole reason this can be a test: the plugin spawns whatever
 * that variable names, so a two-line script is a complete stand-in for a server
 * that comes up, and another for one that fails.
 *
 * Nothing here touches a real Airship, a real dev server, or a real port.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../index.js";

/** The messages the rejection cases look for, hoisted out of the callbacks. */
const NEEDS_PORT = /`port` must be 1-65535 when given/;
const NOTHING_TO_DO = /no dev server is running/;
const EXITED_BEFORE_BANNER = /exited with 1 before printing an editor URL/;
const CHILD_WORDS = /exited before it started listening/;

const fixture = (name) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Register the tools against a minimal context and hand them back by name. */
function mount({ webServerPort } = {}) {
  const tools = {};
  const disposers = [];
  apply({
    effect: (register) => {
      disposers.push(register());
    },
    get: (name) =>
      name === "webServer" && webServerPort !== undefined
        ? { port: webServerPort }
        : undefined,
    tools: {
      register: (definition) => {
        tools[definition.name] = definition;
        return () => undefined;
      },
    },
  });
  return { disposers, tools };
}

/** One call's argv, as the fixture recorded it. */
async function argvOf(run) {
  const file = join(
    tmpdir(),
    `airship-argv-${String(Date.now())}-${String(Math.random()).slice(2)}.json`
  );
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

/**
 * Stop everything still running.
 *
 * The plugin's runs are module state — that is what makes one editor per port a
 * process-wide fact rather than a per-call one — so a test that wants a clean
 * slate has to close what the test before it left behind.
 */
async function reset() {
  await mount().tools.airship_close.execute({});
}

/** Point the plugin at a fixture for the duration of one call. */
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

after(async () => {
  // Nothing should survive a suite that only ever started fixtures, but a
  // failed assertion must not leave one running either way.
  await reset();
});

describe("airship_open", () => {
  it("answers with the URL from the banner and remembers the run", async () => {
    await reset();
    const { tools } = mount();
    const value = await withBinary("airship-banner.mjs", () =>
      tools.airship_open.execute({ port: 47_000 })
    );

    assert.equal(value.url, "http://localhost:47001");
    assert.equal(value.port, 47_000);
    assert.ok(value.pid > 0, "the canonical value carries the child's pid");
    assert.equal(value.mode, "canvas", "a banner naming no mode is the canvas");

    const status = await tools.airship_status.execute({});
    assert.deepEqual(
      status.runs.map((run) => run.port),
      [47_000]
    );
  });

  it("returns the running editor instead of starting a second one", async () => {
    await reset();
    const { tools } = mount();
    const first = await withBinary("airship-banner.mjs", () =>
      tools.airship_open.execute({ port: 47_001 })
    );
    const second = await withBinary("airship-banner.mjs", () =>
      tools.airship_open.execute({ port: 47_001 })
    );

    assert.equal(second.pid, first.pid, "the same child answers both calls");
    const status = await tools.airship_status.execute({});
    assert.equal(
      status.runs.filter((run) => run.port === 47_001).length,
      1,
      "one run per port"
    );
  });

  it("refuses a port that is not one", async () => {
    await reset();
    const { tools } = mount();
    await assert.rejects(
      () => tools.airship_open.execute({ port: "not a port" }),
      NEEDS_PORT
    );
  });

  it("fails with the child's own words when it exits before the banner", async () => {
    await reset();
    const { tools } = mount();
    await assert.rejects(
      () =>
        withBinary("airship-dies.mjs", () =>
          tools.airship_open.execute({ port: 47_002 })
        ),
      (error) => {
        assert.match(error.message, EXITED_BEFORE_BANNER);
        assert.match(error.message, CHILD_WORDS);
        return true;
      }
    );
  });
});

describe("the backend the editor is pointed at", () => {
  it("drives the session that called the tool, on the host serving it", async () => {
    await reset();
    const { tools } = mount({ webServerPort: 47_110 });
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = "/tmp/airship-dsh-home";
    try {
      const argv = await withBinary("airship-banner.mjs", () =>
        argvOf(() =>
          tools.airship_open.execute(
            { port: 47_003 },
            { agent: { id: "session-abc" } }
          )
        )
      );

      assert.deepEqual(argv, [
        "--target",
        "47003",
        "--json",
        "--mode",
        "inline",
        "--dsh-url",
        "http://127.0.0.1:47110",
        "--dsh-session",
        "session-abc",
        "--dsh-home",
        "/tmp/airship-dsh-home",
      ]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previousHome;
      }
    }
  });

  it("stays out of the way when the caller asked for another agent", async () => {
    await reset();
    const { tools } = mount({ webServerPort: 47_110 });
    const argv = await withBinary("airship-banner.mjs", () =>
      argvOf(() =>
        tools.airship_open.execute(
          { agent: "claude", port: 47_004 },
          { agent: { id: "session-abc" } }
        )
      )
    );

    assert.deepEqual(argv, [
      "--target",
      "47004",
      "--json",
      "--mode",
      "inline",
      "--agent",
      "claude",
    ]);
  });

  it("leaves the backend to Airship when no host is serving this call", async () => {
    await reset();
    const { tools } = mount();
    const argv = await withBinary("airship-banner.mjs", () =>
      argvOf(() =>
        tools.airship_open.execute(
          { port: 47_005 },
          { agent: { id: "session-abc" } }
        )
      )
    );

    assert.deepEqual(argv, ["--target", "47005", "--json", "--mode", "inline"]);
  });

  it("passes a chosen surface on as --mode", async () => {
    await reset();
    const { tools } = mount();
    const argv = await withBinary("airship-banner.mjs", () =>
      argvOf(() => tools.airship_open.execute({ mode: "inline", port: 47_006 }))
    );
    assert.deepEqual(argv, ["--target", "47006", "--json", "--mode", "inline"]);
  });
});

describe("airship_close", () => {
  it("stops the run it was asked about and leaves the others", async () => {
    await reset();
    const { tools } = mount();
    await withBinary("airship-banner.mjs", () =>
      tools.airship_open.execute({ port: 47_010 })
    );
    await withBinary("airship-banner.mjs", () =>
      tools.airship_open.execute({ port: 47_011 })
    );

    const closed = await tools.airship_close.execute({ port: 47_010 });
    assert.equal(closed.closed, 1);

    const status = await tools.airship_status.execute({});
    assert.deepEqual(
      status.runs.map((run) => run.port),
      [47_011]
    );

    const rest = await tools.airship_close.execute({});
    assert.equal(rest.closed, 1, "the last one is stopped too");
    assert.deepEqual((await tools.airship_status.execute({})).runs, []);
  });

  it("works the port out from the project when none is given", async () => {
    await reset();
    const { tools } = mount();
    const argv = await withBinary("airship-inspect.mjs", () =>
      argvOf(() => tools.airship_open.execute({ cwd: tmpdir() }))
    );
    // The fixture's inspection says 3000 is listening: attach to it, no exec.
    assert.deepEqual(argv, [
      "--target",
      "3000",
      "--json",
      "--cwd",
      tmpdir(),
      "--mode",
      "inline",
    ]);
  });

  it("starts the project's own dev script when nothing is listening", async () => {
    await reset();
    const previous = process.env.AIRSHIP_INSPECT_JSON;
    process.env.AIRSHIP_INSPECT_JSON = JSON.stringify({
      config: {},
      ports: [{ listening: false, port: 4321, reason: "astro's default port" }],
      startCommand: "pnpm dev",
    });
    try {
      const { tools } = mount();
      const argv = await withBinary("airship-inspect.mjs", () =>
        argvOf(() => tools.airship_open.execute({ cwd: tmpdir() }))
      );
      assert.deepEqual(argv, [
        "--target",
        "4321",
        "--json",
        "--exec",
        "pnpm dev",
        "--cwd",
        tmpdir(),
        "--mode",
        "inline",
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.AIRSHIP_INSPECT_JSON;
      } else {
        process.env.AIRSHIP_INSPECT_JSON = previous;
      }
    }
  });

  it("says so when there is nothing to attach to and nothing to start", async () => {
    await reset();
    const previous = process.env.AIRSHIP_INSPECT_JSON;
    process.env.AIRSHIP_INSPECT_JSON = JSON.stringify({
      config: {},
      ports: [],
    });
    try {
      const { tools } = mount();
      await assert.rejects(
        () =>
          withBinary("airship-inspect.mjs", () =>
            tools.airship_open.execute({ cwd: tmpdir() })
          ),
        NOTHING_TO_DO
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AIRSHIP_INSPECT_JSON;
      } else {
        process.env.AIRSHIP_INSPECT_JSON = previous;
      }
    }
  });
});
