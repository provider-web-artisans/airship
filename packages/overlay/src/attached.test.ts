import { describe, expect, it } from "vitest";
import {
  elementPath,
  postSelection,
  REVEAL_TYPE,
  revealRequest,
  SELECTION_CONSOLE_PREFIX,
  selectionConsoleLine,
  selectionMessage,
} from "./attached";

const element = {
  classes: ["btn", "primary"],
  displayName: "Button",
  tagName: "button",
  textPreview: "Get started",
};

describe("selectionMessage", () => {
  it("carries the element, the bare source location and the editor", () => {
    expect(
      selectionMessage(
        element,
        { column: 3, context: "…", file: "src/Hero.astro", line: 42 },
        "http://localhost:4323/"
      )
    ).toEqual({
      editor: "http://localhost:4323/",
      element,
      source: { column: 3, file: "src/Hero.astro", line: 42 },
      type: "airship:selected",
    });
  });

  it("says so when the node has no source", () => {
    expect(selectionMessage(element, null, "u").source).toBeNull();
  });
});

describe("postSelection", () => {
  it("posts to every ancestor up to the top, and counts them", () => {
    const posted: string[] = [];
    const top = { postMessage: () => posted.push("top") } as unknown as Window;
    (top as { parent: Window }).parent = top;
    const middle = {
      parent: top,
      postMessage: () => posted.push("middle"),
    } as unknown as Window;
    const win = { parent: middle } as unknown as Window;
    const message = selectionMessage(element, null, "u");
    expect(postSelection(message, win)).toBe(2);
    expect(posted).toEqual(["middle", "top"]);
  });

  it("does nothing at the top level", () => {
    const win = {} as Window;
    (win as { parent: Window }).parent = win;
    expect(postSelection(selectionMessage(element, null, "u"), win)).toBe(0);
  });

  it("stops at a parent it cannot read", () => {
    const win = {} as Window;
    Object.defineProperty(win, "parent", {
      get: () => {
        throw new Error("cross-origin");
      },
    });
    expect(postSelection(selectionMessage(element, null, "u"), win)).toBe(0);
  });
});

describe("selectionConsoleLine", () => {
  it("is the prefix and the message as JSON, on one line", () => {
    const message = selectionMessage(element, null, "u");
    const line = selectionConsoleLine(message);
    expect(line.startsWith(SELECTION_CONSOLE_PREFIX)).toBe(true);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line.slice(SELECTION_CONSOLE_PREFIX.length))).toEqual(
      message
    );
  });
});

describe("selectionMessage, with a place", () => {
  it("names the selection and where it is, for a reveal", () => {
    const message = selectionMessage(element, null, "http://localhost:4323/", {
      id: "sel-3",
      path: "body > main:nth-of-type(1) > button:nth-of-type(2)",
    });
    expect(message.id).toBe("sel-3");
    expect(message.path).toBe(
      "body > main:nth-of-type(1) > button:nth-of-type(2)"
    );
  });
});

describe("revealRequest", () => {
  it("takes the id and the path of a reveal, and nothing else", () => {
    expect(
      revealRequest({ id: "sel-1", path: "body > p", type: REVEAL_TYPE })
    ).toEqual({
      id: "sel-1",
      path: "body > p",
    });
    expect(revealRequest({ id: "sel-1", type: REVEAL_TYPE })).toEqual({
      id: "sel-1",
      path: null,
    });
    expect(revealRequest({ type: REVEAL_TYPE })).toBeNull();
    expect(revealRequest({ id: "sel-1", type: "airship:selected" })).toBeNull();
    expect(revealRequest("airship:reveal")).toBeNull();
    expect(revealRequest(null)).toBeNull();
  });
});

describe("elementPath", () => {
  it("walks up to body by type and position, and stops at a unique id", () => {
    document.body.innerHTML =
      "<main><p>a</p><section id='hero'><button>x</button><button>y</button></section></main>";
    const second = document.querySelectorAll("button")[1] as Element;
    const path = elementPath(second);
    expect(path).toBe("#hero > button:nth-of-type(2)");
    expect(document.querySelector(path as string)).toBe(second);
    const p = document.querySelector("p") as Element;
    const pPath = elementPath(p);
    expect(pPath).toBe("body > main:nth-of-type(1) > p:nth-of-type(1)");
    expect(document.querySelector(pPath as string)).toBe(p);
  });

  it("is null for an element outside any document", () => {
    expect(elementPath(document.createElement("div"))).toBeNull();
  });
});
