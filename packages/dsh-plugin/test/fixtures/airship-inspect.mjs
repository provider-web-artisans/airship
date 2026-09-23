#!/usr/bin/env node
// Stands in for the Airship CLI's `inspect` and its `serve`: `inspect --json`
// prints a report shaped by `AIRSHIP_INSPECT_JSON` (or a default with one
// listening port), anything else prints the launch banner and stays up.
// `AIRSHIP_ARGV_FILE` dumps the argv of the *launch* call, as the banner
// fixture does, so tests can pin what detection decided.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "inspect") {
  const report =
    process.env.AIRSHIP_INSPECT_JSON ??
    JSON.stringify({
      config: {},
      cwd: process.cwd(),
      devScript: { command: "astro dev", name: "dev" },
      name: "fixture",
      packageManager: "pnpm",
      ports: [
        { listening: false, port: 4321, reason: "astro's default port" },
        { listening: true, port: 3000, reason: "a common dev-server port" },
      ],
      startCommand: "pnpm dev",
    });
  console.log(report);
  process.exit(0);
}
if (process.env.AIRSHIP_ARGV_FILE) {
  writeFileSync(process.env.AIRSHIP_ARGV_FILE, JSON.stringify(args));
}
console.log(
  JSON.stringify(
    {
      agent: "dsh",
      cwd: process.cwd(),
      port: 47_001,
      targetPort: 47_000,
      url: "http://localhost:47001",
    },
    null,
    2
  )
);
setInterval(() => undefined, 60_000);
