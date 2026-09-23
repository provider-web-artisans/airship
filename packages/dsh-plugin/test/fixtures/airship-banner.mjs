#!/usr/bin/env node
// Stands in for the Airship CLI: prints the `--json` banner, then stays up the
// way a server does, so the plugin's supervision has something to supervise.
// `AIRSHIP_ARGV_FILE` additionally dumps the argv it was called with, which is
// how the tests pin the flags the plugin builds.
import { writeFileSync } from "node:fs";

if (process.env.AIRSHIP_ARGV_FILE) {
  writeFileSync(
    process.env.AIRSHIP_ARGV_FILE,
    JSON.stringify(process.argv.slice(2))
  );
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
// Stay up the way a server does.
setInterval(() => undefined, 60_000);
