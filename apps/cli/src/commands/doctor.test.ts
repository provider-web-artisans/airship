/**
 * `doctor` has no run-level test — it reads the real environment and exits the
 * process — so the parts worth pinning are the ones that decide what it accepts
 * and what it reports: the flag list, and the per-backend location rows.
 */
import { describe, expect, it } from "vitest";
import { backendLocations, DOCTOR_FLAGS } from "./doctor";

/** A path that is certainly there, and one that is certainly not. */
const PRESENT = process.execPath;
const ABSENT = "/nonexistent/airship-doctor-test/dsh";

describe("DOCTOR_FLAGS", () => {
  it("accepts the per-backend locations init and serve accept", () => {
    // Refusing them turns "check my setup" into "your setup is wrong" for the
    // one user who has already told airship where their backend is.
    expect(DOCTOR_FLAGS).toEqual(
      expect.arrayContaining([
        "dsh-path",
        "dsh-agent-dir",
        "pi-path",
        "pi-agent-dir",
      ])
    );
  });

  it("reports nothing and names no binary when no flag is set", () => {
    const { binaries, checks } = backendLocations({}, undefined);
    expect(checks).toEqual([]);
    expect(binaries.size).toBe(0);
  });
});

describe("backendLocations", () => {
  it("checks a named binary and hands it to the agent row", () => {
    const { binaries, checks } = backendLocations(
      { "dsh-path": PRESENT },
      "dsh"
    );
    expect(binaries.get("dsh")).toBe(PRESENT);
    expect(checks).toEqual([
      {
        hint: undefined,
        label: "dsh binary",
        level: "ok",
        value: PRESENT,
      },
    ]);
  });

  it("fails a missing binary only for the backend in use", () => {
    const preferred = backendLocations({ "dsh-path": ABSENT }, "dsh");
    expect(preferred.checks[0]?.level).toBe("fail");
    expect(preferred.checks[0]?.hint).toContain("--dsh-path");

    // The same flag on a claude run is a warning: it breaks nothing that run
    // depends on, and `doctor` exits non-zero on any failure.
    const other = backendLocations({ "dsh-path": ABSENT }, "claude");
    expect(other.checks[0]?.level).toBe("warn");
  });

  it("reads the agent directory too, but only warns when it is absent", () => {
    const { checks } = backendLocations(
      { "dsh-agent-dir": ABSENT, "pi-path": PRESENT },
      "dsh"
    );
    expect(checks).toEqual([
      {
        hint: "Not there yet. The backend creates it on first run if the path is right.",
        label: "dsh home",
        level: "warn",
        value: ABSENT,
      },
      {
        hint: undefined,
        label: "pi binary",
        level: "ok",
        value: PRESENT,
      },
    ]);
  });
});
