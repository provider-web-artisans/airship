/**
 * The host half's two pure decisions, tested without spawning anything.
 *
 * The interesting one is `editorUrlOf`: Airship's `--json` banner arrives as a
 * stream of chunks, so "is the banner complete yet" has to be answered by
 * parsing rather than by counting newlines — a partial read must answer null and
 * a complete one must answer with the editor's URL.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asPort, bannerOf, editorUrlOf } from "../index.js";

describe("reading the editor URL out of the banner", () => {
  it("answers once the whole object has arrived, not before", () => {
    const banner = JSON.stringify(
      {
        agent: "dsh",
        port: 46_000,
        targetPort: 3000,
        url: "http://localhost:46000",
      },
      null,
      2
    );
    const half = banner.slice(0, Math.floor(banner.length / 2));
    assert.equal(editorUrlOf(half), null);
    assert.equal(editorUrlOf(banner), "http://localhost:46000");
  });

  it("answers null for a banner that carries no url", () => {
    assert.equal(editorUrlOf(JSON.stringify({ agent: "dsh" })), null);
  });

  it("answers null while nothing but noise has been printed", () => {
    assert.equal(editorUrlOf(""), null);
    assert.equal(editorUrlOf("Starting Airship…\n"), null);
  });
});

describe("accepting a port", () => {
  it("takes a whole number or a string of one", () => {
    assert.equal(asPort(3000), 3000);
    assert.equal(asPort("3000"), 3000);
    assert.equal(asPort(65_535), 65_535);
  });

  it("refuses anything that is not one", () => {
    for (const value of [
      0,
      -1,
      65_536,
      3.5,
      "abc",
      "",
      null,
      undefined,
      {},
      [],
    ]) {
      assert.equal(
        asPort(value),
        null,
        `expected ${JSON.stringify(value)} to be refused`
      );
    }
  });
});

describe("reading the launch surface out of the banner", () => {
  it("names inline when the banner does", () => {
    const banner = JSON.stringify({ mode: "inline", url: "http://x:1" });
    assert.deepEqual(bannerOf(banner), { mode: "inline", url: "http://x:1" });
  });

  it("names the canvas for canvas, and for a banner that says nothing", () => {
    assert.equal(
      bannerOf(JSON.stringify({ mode: "canvas", url: "u" })).mode,
      "canvas"
    );
    assert.equal(bannerOf(JSON.stringify({ url: "u" })).mode, "canvas");
  });
});
