/**
 * Attached mode: the editor as a pointing device for a conversation that
 * lives somewhere else.
 *
 * With `--dsh-url` the server drives a session inside the DeepSeek Harness,
 * and that harness shows the editor in a sidebar frame beside the session's
 * own chat. Two prompt boxes for one conversation is one too many, so in this
 * mode the overlay keeps no chat dock and, instead of composing a turn itself,
 * tells the document that frames it what was selected. The harness side (the
 * Airship plugin's client half) puts that into the session's composer, and the
 * person writes the instruction there.
 *
 * The message is a plain `postMessage` to the parent window. Its target origin
 * is `*` on purpose: the embedding document's origin is the harness's own
 * scheme (`dsh-app://` in the desktop app), which this code cannot know, and
 * nothing in the payload is secret — a selector, a source location, a text
 * preview, all of which the page already shows on screen. The receiver is the
 * one that has to be careful, and it checks the sender's origin against the
 * editor it opened.
 */
import type { ElementContext, SourceLocation } from "@airship/protocol";

/** The wire shape the framing document receives. */
export interface SelectionMessage {
  /** The editor's own URL, so the receiver can tell which editor spoke. */
  editor: string;
  element: ElementContext;
  /**
   * This selection's name in the editor, and its place in the document, so
   * the receiver can ask for it back — see `revealRequest`. The id names the
   * very node while the page lives; the path finds it again after a reload.
   */
  id?: string;
  path?: string | null;
  source: Pick<SourceLocation, "column" | "file" | "line"> | null;
  type: "airship:selected";
}

/** Where a selection can be found again, for the message. */
export interface SelectionPlace {
  id: string;
  path: string | null;
}

/** The message for one selection. Pure, so the shape is testable. */
export function selectionMessage(
  element: ElementContext,
  source: SourceLocation | null,
  editor: string,
  place?: SelectionPlace
): SelectionMessage {
  return {
    editor,
    element,
    ...(place ? { id: place.id, path: place.path } : {}),
    source: source
      ? { column: source.column, file: source.file, line: source.line }
      : null,
    type: "airship:selected",
  };
}

/** The message type a framing document sends to bring a selection back into view. */
export const REVEAL_TYPE = "airship:reveal";

/** What a reveal asks for: the selection by its name, or by its place. */
export interface RevealRequest {
  id: string | null;
  path: string | null;
}

/**
 * The reveal request in a window message's data, or null when the data is
 * not one. Anyone who can post to this window can send one, and all it can
 * do is select an element the editor already knows, so the check is on the
 * shape alone.
 */
export function revealRequest(data: unknown): RevealRequest | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const { id, path, type } = data as Record<string, unknown>;
  if (type !== REVEAL_TYPE) {
    return null;
  }
  const request = {
    id: typeof id === "string" && id ? id : null,
    path: typeof path === "string" && path ? path : null,
  };
  return request.id === null && request.path === null ? null : request;
}

/**
 * A selector that names one element in its document, from the element up to
 * `body`: an id where the document has it once, `:nth-of-type` otherwise.
 * Null for an element that is not in a document.
 */
export function elementPath(node: Element): string | null {
  const doc = node.ownerDocument;
  if (!(doc && node.isConnected)) {
    return null;
  }
  const steps: string[] = [];
  let current: Element | null = node;
  while (current && current !== doc.body && current !== doc.documentElement) {
    const tag = current.localName;
    if (
      current.id &&
      doc.querySelectorAll(`#${cssEscape(current.id)}`).length === 1
    ) {
      steps.unshift(`#${cssEscape(current.id)}`);
      return steps.join(" > ");
    }
    const parent: Element | null = current.parentElement;
    let nth = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.localName === tag) {
        nth += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    steps.unshift(`${tag}:nth-of-type(${String(nth)})`);
    current = parent;
  }
  if (current === doc.body) {
    steps.unshift("body");
  }
  return steps.join(" > ");
}

/** `CSS.escape` where it exists; the tests' DOM may not have it. */
function cssEscape(text: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  return typeof css?.escape === "function"
    ? css.escape(text)
    : text.replace(/[^\w-]/g, (c) => `\\${c}`);
}

/**
 * The console prefix a selection is announced with, for hosts that hold the
 * editor in a separate web contents rather than a frame.
 *
 * Electron's `<webview>` is such a host: the page inside is top-level in its
 * own world, so `postMessage` has nobody to reach, but the embedding document
 * receives every console line the guest writes as a `console-message` event.
 * One line, this prefix, then the message as JSON — the same message the
 * frame path posts.
 */
export const SELECTION_CONSOLE_PREFIX = "[airship:selected] ";

/** The console line announcing one selection. */
export function selectionConsoleLine(message: SelectionMessage): string {
  return `${SELECTION_CONSOLE_PREFIX}${JSON.stringify(message)}`;
}

/** How many ancestor windows to tell; a self-embedding page would go on forever. */
const MAX_ANCESTORS = 8;

/**
 * Hand a selection to the framing documents, when there are any.
 *
 * Every ancestor up to the top gets it, not only the parent: the harness's
 * Browser tab may sit in a frame of its own inside the harness window, and
 * the listener is in the window, not the tab. A cross-origin hop cannot be
 * inspected but can still be posted to, so the walk continues until
 * `parent === self`, which is the top.
 *
 * @returns how many windows were told: 0 at the top level, where there is
 * nobody to tell.
 */
export function postSelection(
  message: SelectionMessage,
  win: Window = window
): number {
  let told = 0;
  let current: Window = win;
  for (let hop = 0; hop < MAX_ANCESTORS; hop += 1) {
    let parent: Window | null;
    try {
      ({ parent } = current);
    } catch {
      break;
    }
    if (!parent || parent === current) {
      break;
    }
    parent.postMessage(message, "*");
    told += 1;
    current = parent;
  }
  return told;
}
