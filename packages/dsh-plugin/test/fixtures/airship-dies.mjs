#!/usr/bin/env node
// Stands in for a CLI that fails before it can serve anything: nothing on
// stdout, one useful line on stderr, and a non-zero exit.
console.error(
  "✗ Your dev server exited before it started listening on port 47000"
);
process.exit(1);
