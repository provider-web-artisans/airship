/**
 * `inspect` decides without launching; the decisions are what is pinned. The
 * port probe is injected, so nothing here opens a socket.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSPECT_FLAGS, inspectProject, packageManagerOf } from "./inspect";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "airship-inspect-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("inspectProject", () => {
  it("reports every candidate with its reason and whether it answers", async () => {
    const cwd = project({
      "package.json": JSON.stringify({
        devDependencies: { astro: "^5" },
        name: "demo",
        scripts: { dev: "astro dev --port 4322" },
      }),
      "pnpm-lock.yaml": "",
    });
    const inspection = await inspectProject(cwd, {}, (port) =>
      Promise.resolve(port === 4322)
    );
    expect(inspection.name).toBe("demo");
    expect(inspection.ports.slice(0, 2)).toEqual([
      { listening: true, port: 4322, reason: "the port in your dev script" },
      { listening: false, port: 4321, reason: "astro's default port" },
    ]);
    expect(inspection.devScript).toEqual({
      command: "astro dev --port 4322",
      name: "dev",
    });
    expect(inspection.packageManager).toBe("pnpm");
    expect(inspection.startCommand).toBe("pnpm dev");
  });

  it("spells the start command in each package manager's idiom", async () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite" } });
    const npm = await inspectProject(
      project({ "package-lock.json": "{}", "package.json": pkg }),
      {},
      () => Promise.resolve(false)
    );
    expect(npm.startCommand).toBe("npm run dev");
    const yarn = await inspectProject(
      project({ "package.json": pkg, "yarn.lock": "" }),
      {},
      () => Promise.resolve(false)
    );
    expect(yarn.startCommand).toBe("yarn dev");
    const bun = await inspectProject(
      project({ "bun.lock": "", "package.json": pkg }),
      {},
      () => Promise.resolve(false)
    );
    expect(bun.startCommand).toBe("bun run dev");
  });

  it("has no start command without a dev script, and still guesses ports", async () => {
    const inspection = await inspectProject(project({}), {}, () =>
      Promise.resolve(false)
    );
    expect(inspection.startCommand).toBeUndefined();
    expect(inspection.devScript).toBeUndefined();
    expect(inspection.ports.map((p) => p.port)).toEqual([
      3000, 5173, 8080, 4321, 4200,
    ]);
  });

  it("surfaces a target and exec the config already pins", async () => {
    const inspection = await inspectProject(
      project({}),
      { exec: "pnpm dev", target: "3100" },
      () => Promise.resolve(false)
    );
    expect(inspection.config).toEqual({ exec: "pnpm dev", target: 3100 });
  });

  it("defaults the package manager to npm", () => {
    expect(packageManagerOf(project({}))).toBe("npm");
  });

  it("accepts cwd, target and exec beside the global flags", () => {
    expect(INSPECT_FLAGS).toEqual(
      expect.arrayContaining(["cwd", "target", "exec", "json"])
    );
  });
});
