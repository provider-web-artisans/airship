/**
 * The client half, tested without a browser.
 *
 * The page has to put the editor somewhere, and where depends on the profile:
 * the Browser tab is a package of its own, so a composition can leave it out —
 * a bare `web` profile does, the desktop app mounts it. And what the editor
 * selects has to reach the right session's composer, and only from an editor
 * this page opened. Both are pinned here.
 *
 * `client.js` is a browser module: it registers itself on
 * `window.__ModuleLoader__` at import time and asks for React through the
 * loader's `require`. Both are stubs below, which is what keeps this a unit
 * test rather than a browser run.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/** Every `window.open` the row made. */
const opened = [];
/** The module registration `client.js` pushes onto the loader. */
let registration = null;

/** Window message listeners the plugin installed. */
const listeners = [];
/** What the bridge logged; the desktop echoes this to its terminal. */
const logged = [];
globalThis.console = {
  ...console,
  warn: (text) => logged.push(String(text)),
};
/** The host's status answer for a bridge asked about an origin it did not open. */
let hostRuns = [];
globalThis.fetch = (input) => {
  const href = String(input);
  if (href.includes("/airship/status")) {
    return Promise.resolve({
      json: () => Promise.resolve({ runs: hostRuns }),
      ok: true,
      status: 200,
    });
  }
  return Promise.reject(new Error(`unexpected fetch ${href}`));
};
/**
 * A document with one Electron-style `<webview>`: the plugin listens to its
 * `console-message` events, which is how the desktop app's Browser tab
 * reaches the page. `MutationObserver` is present but inert.
 */
const webviewListeners = [];
/** What the desktop's webview shows, and the script it was asked to run. */
const webviewState = { executed: [], url: "about:blank" };
const webview = {
  addEventListener: (type, listener) => {
    if (type === "console-message") {
      webviewListeners.push(listener);
    }
  },
  executeJavaScript: (code) => {
    webviewState.executed.push(code);
    return Promise.resolve();
  },
  getAttribute: () => null,
  getURL: () => webviewState.url,
  removeEventListener: () => undefined,
  tagName: "WEBVIEW",
};
/** Session storage, where the plugin remembers that it took the sidebar. */
const session = new Map();
globalThis.sessionStorage = {
  getItem: (key) => session.get(key) ?? null,
  removeItem: (key) => session.delete(key),
  setItem: (key, value) => session.set(key, String(value)),
};

/** What the app frame currently says on its data attributes. */
const frameState = { fullscreen: false, sidebarCollapsed: false };
/** Attributes the plugin sets on the document root while arranged. */
const rootAttributes = new Map();
/** Style tags the plugin installed. */
const styles = [];
/** Listeners the plugin put on the document. */
const documentListeners = [];
/** The document's selection, as the removal of a chip sets it. */
const selectionState = { calls: [] };
globalThis.InputEvent = class InputEvent {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
};
globalThis.document = {
  addEventListener: (type, listener, capture) => {
    documentListeners.push({ capture, listener, type });
  },
  createElement: () => {
    const tag = { dataset: {}, textContent: "" };
    return tag;
  },
  documentElement: {
    removeAttribute: (name) => rootAttributes.delete(name),
    setAttribute: (name, value) => rootAttributes.set(name, value),
  },
  head: { appendChild: (tag) => styles.push(tag) },
  querySelector: (selector) => {
    if (selector.startsWith("style[data-plugin-css=")) {
      const id = selector.slice('style[data-plugin-css="'.length, -2);
      return styles.find((tag) => tag.dataset.pluginCss === id) ?? null;
    }
    if (selector === "[data-sidebar-collapsed]") {
      return frameState.sidebarCollapsed ? {} : null;
    }
    if (selector === "[data-rightbar-fullscreen]") {
      return frameState.fullscreen ? {} : null;
    }
    return null;
  },
  querySelectorAll: (selector) => (selector === "webview" ? [webview] : []),
  removeEventListener: (_type, listener) => {
    const at = documentListeners.findIndex((l) => l.listener === listener);
    if (at >= 0) {
      documentListeners.splice(at, 1);
    }
  },
};
globalThis.MutationObserver = class {
  disconnect = () => undefined;
  observe = () => undefined;
};

globalThis.window = {
  __ModuleLoader__: {
    load: (module) => {
      registration = module;
    },
  },
  addEventListener: (type, listener) => {
    if (type === "message") {
      listeners.push(listener);
    }
  },
  getSelection: () => ({
    setBaseAndExtent: (...args) => {
      selectionState.calls.push(args);
    },
  }),
  open: (url, target, features) => {
    opened.push({ features, target, url });
    return null;
  },
  removeEventListener: (type, listener) => {
    const at = listeners.indexOf(listener);
    if (type === "message" && at !== -1) {
      listeners.splice(at, 1);
    }
  },
};

/**
 * Just enough React to build an element tree with callable props, plus a
 * `useState` that holds its values for the one synchronous render a test
 * does — setting state records the value and re-renders nothing.
 */
const hookState = [];
let hookCursor = 0;
/** Effect cleanups the stub collected; calling them is "unmount". */
const cleanups = [];
const react = {
  createElement: (type, props, ...children) => ({
    children,
    props: { ...props, children },
    type,
  }),
  // Runs an effect on the first render and again only when its deps change,
  // the way React does; a stub that ran it on every render would make the
  // page look the project up once per render instead of once per session.
  useEffect: (effect, deps) => {
    const index = hookCursor;
    hookCursor += 1;
    const previous = hookState[index];
    const same =
      previous !== undefined &&
      Array.isArray(deps) &&
      Array.isArray(previous.deps) &&
      deps.length === previous.deps.length &&
      deps.every((dep, i) => Object.is(dep, previous.deps[i]));
    if (same) {
      return;
    }
    hookState[index] = { deps };
    const cleanup = effect();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup);
    }
  },
  useRef: (initial) => {
    const index = hookCursor;
    hookCursor += 1;
    if (!(index in hookState)) {
      hookState[index] = { current: initial };
    }
    return hookState[index];
  },
  useState: (initial) => {
    const index = hookCursor;
    hookCursor += 1;
    if (!(index in hookState)) {
      hookState[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      hookState[index],
      (next) => {
        hookState[index] =
          typeof next === "function" ? next(hookState[index]) : next;
      },
    ];
  },
};

/**
 * Resolve a tree the way React would: a node whose type is a function is that
 * component's own render, and its children are resolved in turn.
 */
function render(node) {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (typeof node.type === "function") {
    hookCursor = 0;
    return render(node.type(node.props));
  }
  return { ...node, children: (node.children ?? []).map(render) };
}

/**
 * Render the page with its Options open: the fields live behind a
 * disclosure that starts closed, and the stub's `useState` keeps it open
 * for the renders that follow.
 */
function withOptions(Page, props) {
  const closed = render(Page(props));
  const options = findButton(closed, "Options");
  if (options) {
    options.props.onClick();
  }
  return render(Page(props));
}

/** What a button is called: its accessible label for an icon button, else its text. */
const labelOf = (button) =>
  button.props?.["aria-label"] ?? button.children?.[0];

/** The first button in a tree called `label`, or null. */
function findButton(node, label) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (node.type === "button" && labelOf(node) === label) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findButton(child, label);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Walk a resolved element tree for the first node of a given type. */
function find(node, type) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (node.type === type) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = find(child, type);
    if (found) {
      return found;
    }
  }
  return null;
}

/** What the host's inspect route answers, unless a test says otherwise. */
const inspection = (
  launch = { port: 4321, reason: "astro's default port" }
) => ({
  launch,
  name: "demo",
  ports: [],
});

/**
 * A fetcher that answers the inspect route with `found` and the open route
 * with `opened`, recording what it was asked. `opened` may be a promise
 * factory for a test that wants to hold the answer back.
 */
function fetcherFor({
  found = inspection(),
  opened: answer,
  requests = [],
  running = [],
} = {}) {
  return (input, init) => {
    const href = String(input);
    requests.push({ init, url: href });
    if (href.includes("/airship/status")) {
      return Promise.resolve({
        json: () => Promise.resolve({ runs: running }),
        ok: true,
        status: 200,
      });
    }
    if (href.includes("/airship/close")) {
      return Promise.resolve({
        json: () => Promise.resolve({ closed: true }),
        ok: true,
        status: 200,
      });
    }
    if (href.includes("/airship/stop")) {
      return Promise.resolve({
        json: () => Promise.resolve({ closed: false, stopped: [4242] }),
        ok: true,
        status: 200,
      });
    }
    if (href.includes("/airship/inspect")) {
      return Promise.resolve({
        json: () => Promise.resolve(found),
        ok: true,
        status: 200,
      });
    }
    return typeof answer === "function" ? answer() : Promise.resolve(answer);
  };
}

/**
 * Mount the plugin against a context of the caller's choosing.
 *
 * `browserTabsRegistered` stands for a composition with the right-sidebar kit:
 * the Browser tab exists, and `inject` for `sidebarRightTabs` fires, so the
 * Airship page registers too. Without it only the row is mounted.
 */
function mount({ browserTabsRegistered }) {
  const registry = { definitions: [] };
  const context = {
    bodies: {},
    composers: {},
    get: (name) => {
      if (name === "layout") {
        return {
          toggleSidebar: () => {
            frameState.sidebarCollapsed = !frameState.sidebarCollapsed;
            context.layoutCalls.push(["toggleSidebar"]);
          },
        };
      }
      return name === "sidebarRightTabs" && browserTabsRegistered
        ? { get: (kind) => (kind === "browser" ? {} : undefined) }
        : undefined;
    },
    inject: (deps, callback) => {
      if (deps.includes("inputTriggers")) {
        callback({
          effect: (register) => register(),
          inputTriggers: {
            registerSource: (source) => {
              context.sources.push(source);
              return () => undefined;
            },
          },
        });
        return;
      }
      if (deps.includes("conversation")) {
        callback({
          conversation: {
            input: { for: (scope) => context.composers[scope.sessionId] },
          },
          effect: (register) => register(),
          sessions: {
            scope: (id) =>
              id in context.composers ? { sessionId: id } : undefined,
          },
        });
        return;
      }
      if (!(browserTabsRegistered && deps.includes("sidebarRightTabs"))) {
        return;
      }
      callback({
        effect: (register) => register(),
        sidebarRightTabs: {
          register: (definition) => {
            registry.definitions.push(definition);
            return () => undefined;
          },
        },
        slots: context.slots,
      });
    },
    layoutCalls: [],
    registry,
    sidebarRight: {
      actions: {
        setExpanded: (sessionId, on) =>
          context.layoutCalls.push(["setExpanded", sessionId, on]),
        setMode: (sessionId, mode) =>
          context.layoutCalls.push(["setMode", sessionId, mode]),
      },
      openTab: (kind, options) => opened.push({ kind, ...options }),
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        if (options.name === "tool.call.toolview") {
          context.component = component;
        }
        context.bodies[options.key] = component;
      },
    },
    sources: [],
  };
  const body = registration.factory((name) => {
    if (name !== "react") {
      throw new Error(
        `the row should only ask the loader for react, not ${name}`
      );
    }
    return react;
  });
  // `inject` is the loader's business; only the body matters here.
  body.apply(context);
  return { context };
}

before(async () => {
  await import("../client.js");
  if (!registration) {
    throw new Error("client.js should register itself on the module loader");
  }
});

describe("the Airship page", () => {
  const PAGE_ID = "@provider-web-artisans/dsh-plugin/airship";

  it("registers as a sidebar tab type with a guide entry", () => {
    const Row = mount({ browserTabsRegistered: true });
    const [definition] = Row.context.registry.definitions;
    assert.equal(definition.id, PAGE_ID);
    assert.equal(definition.kind, "airship");
    assert.equal(definition.title(), "Airship");
    assert.equal(definition.guide[0].title(), "Airship");
    assert.ok(Row.context.bodies[PAGE_ID], "the page body is registered");
  });

  it("stays off a composition without the sidebar kit", () => {
    const Row = mount({ browserTabsRegistered: false });
    assert.deepEqual(Row.context.registry.definitions, []);
    assert.equal(Row.context.bodies[PAGE_ID], undefined);
  });

  it("asks the host to open the editor for this session and shows it", async () => {
    opened.length = 0;
    hookState.length = 0;
    const requests = [];
    const Row = mount({ browserTabsRegistered: true });
    const Page = Row.context.bodies[PAGE_ID];
    const props = {
      fetcher: fetcherFor({
        opened: {
          json: () =>
            Promise.resolve({ mode: "inline", url: "http://127.0.0.1:3001" }),
          ok: true,
          status: 200,
        },
        requests,
      }),
      sessionId: "session-1",
      useSessions: (select) =>
        select({ byId: { "session-1": { cwd: "/work/app" } } }),
    };
    // Type the port, then render again the way React would after a state
    // change: the stub's `useState` keeps the value, and the fresh submit
    // handler closes over it.
    find(withOptions(Page, props), "input").props.onChange({
      target: { value: "3000" },
    });
    const tree = render(Page(props));
    await find(tree, "form").props.onSubmit({
      preventDefault: () => undefined,
    });

    const open = requests.filter((r) => r.url.endsWith("/airship/open"));
    assert.equal(open.length, 1);
    assert.equal(open[0].init.method, "POST");
    assert.deepEqual(JSON.parse(open[0].init.body), {
      mode: "inline",
      port: 3000,
      sessionId: "session-1",
      takeover: false,
    });
    assert.deepEqual(opened, [
      {
        kind: "browser",
        params: { url: "http://127.0.0.1:3001/?__airship=inline" },
      },
    ]);
  });

  it("refuses to submit without a usable port", async () => {
    opened.length = 0;
    hookState.length = 0;
    const requests = [];
    const Row = mount({ browserTabsRegistered: true });
    const Page = Row.context.bodies[PAGE_ID];
    const tree = render(
      Page({
        // An inspection that found nothing, so the port stays empty.
        fetcher: fetcherFor({
          found: inspection({ error: "nothing here" }),
          opened: () => Promise.reject(new Error("must not be reached")),
          requests,
        }),
        sessionId: "session-1",
      })
    );
    await find(tree, "form").props.onSubmit({
      preventDefault: () => undefined,
    });
    assert.equal(
      requests.filter((r) => r.url.endsWith("/airship/open")).length,
      0
    );
    assert.deepEqual(opened, []);
  });

  it("opens from the tab's own action when it has one, so it lands in this session", async () => {
    opened.length = 0;
    hookState.length = 0;
    const tabOpened = [];
    const Row = mount({ browserTabsRegistered: true });
    const Page = Row.context.bodies[PAGE_ID];
    const props = {
      fetcher: fetcherFor({
        opened: {
          json: () =>
            Promise.resolve({ mode: "canvas", url: "http://127.0.0.1:3001" }),
          ok: true,
          status: 200,
        },
      }),
      sessionId: "session-1",
      useTabInfo: () => ({
        tab: {
          actions: {
            openTab: (kind, options) => tabOpened.push({ kind, ...options }),
          },
          signal: { aborted: false },
        },
      }),
    };
    find(withOptions(Page, props), "input").props.onChange({
      target: { value: "3000" },
    });
    await find(render(Page(props)), "form").props.onSubmit({
      preventDefault: () => undefined,
    });
    assert.deepEqual(opened, [], "the global opener is not used");
    assert.deepEqual(tabOpened, [
      {
        kind: "browser",
        params: { url: "http://127.0.0.1:3001/?__airship=shell" },
      },
    ]);
  });

  it("does nothing with an answer that arrives after the page is gone", async () => {
    opened.length = 0;
    hookState.length = 0;
    cleanups.length = 0;
    let answer;
    const Row = mount({ browserTabsRegistered: true });
    const Page = Row.context.bodies[PAGE_ID];
    const props = {
      fetcher: fetcherFor({
        opened: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }),
      sessionId: "session-1",
    };
    find(withOptions(Page, props), "input").props.onChange({
      target: { value: "3000" },
    });
    const submitted = find(render(Page(props)), "form").props.onSubmit({
      preventDefault: () => undefined,
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
    answer({
      json: () =>
        Promise.resolve({ mode: "canvas", url: "http://127.0.0.1:3001" }),
      ok: true,
      status: 200,
    });
    await submitted;
    assert.deepEqual(opened, []);
  });

  it("shows this session's editor with the surface the host lists", async () => {
    opened.length = 0;
    hookState.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const Page = context.bodies[PAGE_ID];
    const props = {
      fetcher: fetcherFor({
        running: [
          {
            mode: "inline",
            port: 3000,
            sessionId: "session-1",
            url: "http://127.0.0.1:3001",
          },
        ],
      }),
      sessionId: "session-1",
    };
    render(Page(props));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const show = findButton(render(Page(props)), "Show the editor");
    assert.ok(show, "this session's editor is the main action");
    show.props.onClick();
    assert.equal(
      opened[0].params.url,
      "http://127.0.0.1:3001/?__airship=inline"
    );
  });

  it("looks the project up when it opens and prefills what it found", async () => {
    opened.length = 0;
    hookState.length = 0;
    const requests = [];
    const Row = mount({ browserTabsRegistered: true });
    const Page = Row.context.bodies[PAGE_ID];
    const props = {
      fetcher: fetcherFor({
        found: inspection({
          command: "pnpm dev",
          port: 4321,
          reason: "astro's default port",
        }),
        requests,
      }),
      sessionId: "session-1",
    };
    render(Page(props));
    // The look-up is async; let it land, then render the way React would.
    await new Promise((resolve) => setImmediate(resolve));
    const tree = withOptions(Page, props);
    const look = requests.filter((r) => r.url.includes("/airship/inspect"));
    assert.equal(look.length, 1);
    assert.ok(look[0].url.includes("sessionId=session-1"), look[0].url);
    const inputs = [];
    (function walk(node) {
      if (!node || typeof node !== "object") {
        return;
      }
      if (node.type === "input") {
        inputs.push(node);
      }
      for (const child of node.children ?? []) {
        walk(child);
      }
    })(tree);
    assert.equal(inputs[0].props.value, "4321", "the port is prefilled");
    assert.equal(inputs[1].props.value, "pnpm dev", "so is the start command");
  });
});

describe("the selection bridge", () => {
  /**
   * A composer that remembers its draft, and — unless `plain` — takes chips
   * the way the real one does: an atomic reference whose clipboard text
   * joins the draft, at the span given.
   */
  const composer = (draft = "", { plain = false } = {}) => {
    const box = { chips: [], draft, rev: 3 };
    const target = {
      box,
      setDraft: (text) => {
        box.draft = text;
      },
      state: { getSnapshot: () => ({ draft: box.draft, draftRev: box.rev }) },
    };
    if (!plain) {
      target.insertReference = (ref, span) => {
        if (span.draftRev !== box.rev) {
          return false;
        }
        box.chips.push(ref);
        box.draft = `${box.draft.slice(0, span.start)}${ref.clipboardText} ${box.draft.slice(span.end)}`;
        box.rev += 1;
        return true;
      };
    }
    return target;
  };

  const selected = (origin, extra = {}) => ({
    data: {
      editor: `${origin}/`,
      element: {
        classes: ["btn", "primary"],
        displayName: "Button",
        tagName: "button",
        textPreview: "Get started",
      },
      source: { file: "src/Hero.astro", line: 42 },
      type: "airship:selected",
      ...extra,
    },
    origin,
  });

  /** Open the editor for a session through the page, so the bridge knows it. */
  async function openFor(context, sessionId, url) {
    hookState.length = 0;
    const Page = context.bodies["@provider-web-artisans/dsh-plugin/airship"];
    const props = {
      fetcher: fetcherFor({
        opened: {
          json: () => Promise.resolve({ mode: "canvas", url }),
          ok: true,
          status: 200,
        },
      }),
      sessionId,
    };
    find(withOptions(Page, props), "input").props.onChange({
      target: { value: "3000" },
    });
    await find(render(Page(props)), "form").props.onSubmit({
      preventDefault: () => undefined,
    });
  }

  it("adds a chip to the composer of the session that opened the editor, ahead of the draft", async () => {
    listeners.length = 0;
    opened.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("make it blue");
    context.composers["session-1"] = mine;
    context.composers["session-2"] = composer("other");
    await openFor(context, "session-1", "http://127.0.0.1:4323");

    assert.equal(listeners.length, 1, "one message listener");
    await listeners[0](
      selected("http://127.0.0.1:4323", { id: "sel-7", path: "body > button" })
    );
    assert.equal(mine.box.chips.length, 1);
    const [chip] = mine.box.chips;
    assert.deepEqual(
      { ...chip, ref: JSON.parse(chip.ref) },
      {
        appearance: "file",
        clipboardText:
          "@src/Hero.astro (Airship selection: <button.btn.primary> (Button) at src/Hero.astro:42 — “Get started”)",
        label: "<button.btn.primary> Hero.astro:42",
        ref: {
          editor: "http://127.0.0.1:4323/",
          element: {
            classes: ["btn", "primary"],
            displayName: "Button",
            tagName: "button",
            textPreview: "Get started",
          },
          id: "sel-7",
          path: "body > button",
          source: { file: "src/Hero.astro", line: 42 },
        },
        source: "airship",
      }
    );
    assert.ok(mine.box.draft.endsWith(" make it blue"), mine.box.draft);
    assert.equal(context.composers["session-2"].box.draft, "other");
  });

  it("keeps several chips, and does not add the same element twice", async () => {
    listeners.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("");
    context.composers["session-1"] = mine;
    await openFor(context, "session-1", "http://127.0.0.1:4323");
    await listeners[0](selected("http://127.0.0.1:4323"));
    await listeners[0](selected("http://127.0.0.1:4323"));
    await listeners[0](
      selected("http://127.0.0.1:4323", {
        element: {
          classes: [],
          displayName: null,
          tagName: "h1",
          textPreview: "",
        },
        source: null,
      })
    );
    assert.deepEqual(
      mine.box.chips.map((c) => c.label),
      ["<button.btn.primary> Hero.astro:42", "<h1>"]
    );
    assert.equal(mine.box.chips[1].clipboardText, "(Airship selection: <h1>)");
  });

  it("falls back to a text line when the composer takes no chips", async () => {
    listeners.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("make it blue", { plain: true });
    context.composers["session-1"] = mine;
    await openFor(context, "session-1", "http://127.0.0.1:4323");
    await listeners[0](selected("http://127.0.0.1:4323"));
    assert.equal(
      mine.box.draft,
      "Airship selection: <button.btn.primary> (Button) at src/Hero.astro:42 — “Get started”\nmake it blue"
    );
  });

  it("replaces an earlier selection line instead of stacking them, as text", async () => {
    listeners.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("", { plain: true });
    context.composers["session-1"] = mine;
    await openFor(context, "session-1", "http://127.0.0.1:4323");
    await listeners[0](selected("http://127.0.0.1:4323"));
    await listeners[0](
      selected("http://127.0.0.1:4323", {
        element: {
          classes: [],
          displayName: null,
          tagName: "h1",
          textPreview: "",
        },
        source: null,
      })
    );
    assert.equal(mine.box.draft, "Airship selection: <h1>\n");
  });

  it("ignores a message from an origin it did not open, or of another shape", async () => {
    listeners.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("keep");
    context.composers["session-1"] = mine;
    await openFor(context, "session-1", "http://127.0.0.1:4323");
    await listeners[0](selected("http://evil.example"));
    await listeners[0]({
      data: { type: "something-else" },
      origin: "http://127.0.0.1:4323",
    });
    await listeners[0]({ data: null, origin: "http://127.0.0.1:4323" });
    assert.equal(mine.box.draft, "keep");
  });
  it("recognises an editor the host lists even when this page never opened it", async () => {
    listeners.length = 0;
    logged.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("");
    context.composers["session-7"] = mine;
    hostRuns = [
      { port: 4321, sessionId: "session-7", url: "http://localhost:4323" },
    ];
    // The frame says 127.0.0.1 where the host said localhost: same editor.
    await listeners[0](selected("http://127.0.0.1:4323"));
    assert.equal(mine.box.chips.length, 1, mine.box.draft);
    assert.ok(
      logged.some((l) => l.includes("added a chip") && l.includes("session-7")),
      logged.join("\n")
    );
    hostRuns = [];
  });

  it("says why it ignored a message, so the terminal shows it", async () => {
    listeners.length = 0;
    logged.length = 0;
    mount({ browserTabsRegistered: true });
    await listeners[0](selected("http://127.0.0.1:9999"));
    assert.ok(
      logged.some((l) => l.includes("no editor of ours has that origin")),
      logged.join("\n")
    );
  });

  it("hears a selection the editor announced on a webview's console", async () => {
    listeners.length = 0;
    webviewListeners.length = 0;
    logged.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const mine = composer("");
    context.composers["session-8"] = mine;
    hostRuns = [
      { port: 4321, sessionId: "session-8", url: "http://localhost:4323" },
    ];
    assert.equal(webviewListeners.length, 1, "the webview is listened to");
    const message = selected("http://localhost:4323").data;
    await webviewListeners[0]({
      message: `[airship:selected] ${JSON.stringify(message)}`,
      sourceId: "http://localhost:4323/__airship/overlay.js",
    });
    assert.equal(mine.box.chips.length, 1, mine.box.draft);
    // Any other console line is not a selection.
    await webviewListeners[0]({ message: "[vite] connected.", sourceId: "x" });
    hostRuns = [];
  });
  describe("the chips' own @ source", () => {
    /** A chip as the bridge writes it for a selection from `origin`. */
    async function chipFrom(context, origin, extra) {
      const mine = composer("");
      context.composers["session-1"] = mine;
      await openFor(context, "session-1", origin);
      // The listener this mount registered is the latest one.
      await listeners.at(-1)(selected(origin, extra));
      return mine.box.chips[0];
    }

    it("registers an @ source named for the chips, that lists nothing", async () => {
      const { context } = mount({ browserTabsRegistered: true });
      assert.equal(context.sources.length, 1);
      const [source] = context.sources;
      assert.equal(source.trigger, "@");
      assert.equal(source.name, "airship");
      assert.equal(source.showGroupTitle, false);
      assert.deepEqual(await source.candidates({}, { query: "" }), []);
      assert.equal(source.onPick({}), undefined);
    });

    it("serializes a chip to the words the model reads: the same as its clipboard text", async () => {
      const { context } = mount({ browserTabsRegistered: true });
      const chip = await chipFrom(context, "http://127.0.0.1:4323", {
        id: "sel-1",
      });
      const [source] = context.sources;
      assert.equal(
        await source.codec.serialize(chip.ref, new AbortController().signal),
        chip.clipboardText
      );
      assert.equal(source.codec.clipboardText(chip.ref), chip.clipboardText);
    });

    it("still serializes a reference it cannot read, rather than blocking the send", async () => {
      const { context } = mount({ browserTabsRegistered: true });
      const [source] = context.sources;
      assert.equal(
        await source.codec.serialize("not json", new AbortController().signal),
        "(Airship selection: <element>)"
      );
    });

    it("a click on a chip asks the editor, through its webview, for the element back", async () => {
      const { context } = mount({ browserTabsRegistered: true });
      const chip = await chipFrom(context, "http://127.0.0.1:4323", {
        id: "sel-9",
        path: "body > main:nth-of-type(1) > button:nth-of-type(2)",
      });
      webviewState.url = "http://localhost:4323/?__airship=inline";
      webviewState.executed.length = 0;
      const [source] = context.sources;
      const taken = source.openReference(
        { sessionId: "session-1" },
        { appearance: "file", ref: chip.ref }
      );
      assert.equal(taken, true);
      assert.equal(webviewState.executed.length, 1);
      const [code] = webviewState.executed;
      assert.ok(code.startsWith("window.postMessage("), code);
      assert.deepEqual(
        JSON.parse(code.slice("window.postMessage(".length, -', "*")'.length)),
        {
          id: "sel-9",
          path: "body > main:nth-of-type(1) > button:nth-of-type(2)",
          type: "airship:reveal",
        }
      );
    });

    it("leaves the click to the composer when no editor of that origin is showing", async () => {
      const { context } = mount({ browserTabsRegistered: true });
      const chip = await chipFrom(context, "http://127.0.0.1:4323", {
        id: "sel-2",
      });
      webviewState.url = "http://localhost:5555/";
      webviewState.executed.length = 0;
      const [source] = context.sources;
      assert.equal(
        source.openReference(
          { sessionId: "session-1" },
          { appearance: "file", ref: chip.ref }
        ),
        false
      );
      assert.equal(webviewState.executed.length, 0);
    });

    /** A chip in the composer's document: its host, face, siblings and root. */
    function chipInDocument() {
      const dispatched = [];
      const root = {
        dispatchEvent: (event) => {
          dispatched.push(event);
          return true;
        },
        focus: () => undefined,
      };
      const parent = { childNodes: [] };
      const host = {
        closest: (selector) => {
          if (selector === '[data-composer-chip="airship"]') {
            return host;
          }
          return selector === "[data-composer-input]" ? root : null;
        },
        firstElementChild: {
          getBoundingClientRect: () => ({ left: 100, right: 300 }),
        },
        parentNode: parent,
      };
      parent.childNodes.push({ text: "before" }, host, { text: " after" });
      return { dispatched, host, parent, root };
    }

    /** A click on `host` at `clientX`, remembering what was done to it. */
    function clickOn(host, clientX) {
      const event = {
        clientX,
        defaultPrevented: false,
        preventDefault: () => {
          event.defaultPrevented = true;
        },
        propagationStopped: false,
        stopPropagation: () => {
          event.propagationStopped = true;
        },
        target: host,
      };
      return event;
    }

    it("removes a chip from its ×: the caret goes after it, and the editor is asked to delete backward", () => {
      documentListeners.length = 0;
      selectionState.calls.length = 0;
      mount({ browserTabsRegistered: true });
      const click = documentListeners.find(
        (l) => l.type === "click" && l.capture === true
      );
      assert.ok(click, "a capturing click listener on the document");
      const { dispatched, host, parent } = chipInDocument();
      const event = clickOn(host, 290);
      click.listener(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(
        event.propagationStopped,
        true,
        "the composer's own click never sees it"
      );
      assert.deepEqual(selectionState.calls, [[parent, 2, parent, 2]]);
      assert.equal(dispatched.length, 1, "one event on the editor's root");
      assert.equal(dispatched[0].type, "beforeinput");
      assert.equal(dispatched[0].inputType, "deleteContentBackward");
      assert.equal(dispatched[0].cancelable, true);
    });

    it("leaves a click on the rest of the chip to the composer, for the reveal", () => {
      documentListeners.length = 0;
      selectionState.calls.length = 0;
      mount({ browserTabsRegistered: true });
      const click = documentListeners.find((l) => l.type === "click");
      const { dispatched, host } = chipInDocument();
      const event = clickOn(host, 150);
      click.listener(event);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
      assert.deepEqual(selectionState.calls, []);
      assert.equal(dispatched.length, 0);
    });

    it("dresses the chips as Airship pills through the stylesheet", async () => {
      styles.length = 0;
      const { context } = mount({ browserTabsRegistered: true });
      await chipFrom(context, "http://127.0.0.1:4323", { id: "sel-3" });
      const rule = styles.map((tag) => tag.textContent).join("\n");
      assert.ok(
        rule.includes(
          '[data-composer-chip="airship"] > span > svg { display: none; }'
        ),
        rule
      );
      assert.ok(
        rule.includes('[data-composer-chip="airship"] > span::before') &&
          rule.includes('mask: url("data:image/svg+xml'),
        rule
      );
      assert.ok(
        rule.includes(
          '[data-composer-chip="airship"] > span::after { content: "\\00d7";'
        ),
        rule
      );
    });
  });
});

describe("the running editors list", () => {
  const PAGE_ID = "@provider-web-artisans/dsh-plugin/airship";
  const mine = {
    cwd: "/work/app",
    mode: "canvas",
    pid: 1,
    port: 3000,
    sessionId: "session-1",
    url: "http://127.0.0.1:3001",
  };
  const theirs = {
    ...mine,
    port: 4321,
    sessionId: "session-2",
    url: "http://127.0.0.1:4322",
  };

  /** Walk a rendered tree for nodes of one type. */
  function all(node, type, out = []) {
    if (!node || typeof node !== "object") {
      return out;
    }
    if (node.type === type) {
      out.push(node);
    }
    for (const child of node.children ?? []) {
      all(child, type, out);
    }
    return out;
  }

  /** Render, let the look-up and status land, render again. */
  async function settled(Page, props) {
    hookState.length = 0;
    render(Page(props));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return render(Page(props));
  }

  it("puts this session's editor first, and lists another session's below", async () => {
    opened.length = 0;
    const { context } = mount({ browserTabsRegistered: true });
    const tree = await settled(context.bodies[PAGE_ID], {
      fetcher: fetcherFor({ running: [mine, theirs] }),
      sessionId: "session-1",
    });
    const labels = all(tree, "button").map(labelOf);
    const editorLabels = [
      "Show the editor",
      "Fullscreen",
      "Close the editor",
      "Use in this session",
      "Close that editor",
    ];
    assert.deepEqual(
      labels.filter((l) => editorLabels.includes(l)),
      editorLabels
    );
    findButton(tree, "Show the editor").props.onClick();
    assert.equal(
      opened[0].params.url,
      "http://127.0.0.1:3001/?__airship=shell"
    );
  });

  it("stops the site on the port that answers, for this session, and looks again", async () => {
    const requests = [];
    const { context } = mount({ browserTabsRegistered: true });
    const tree = await settled(context.bodies[PAGE_ID], {
      fetcher: fetcherFor({ requests, running: [] }),
      sessionId: "session-1",
    });
    const stop = findButton(tree, "Stop the site");
    assert.ok(stop, "a site that answers can be stopped");
    const looked = requests.filter((r) => r.url.includes("/airship/inspect"));
    await stop.props.onClick();
    const posted = requests.find((r) => r.url.endsWith("/airship/stop"));
    assert.deepEqual(JSON.parse(posted.init.body), {
      port: 4321,
      sessionId: "session-1",
    });
    assert.ok(
      requests.filter((r) => r.url.includes("/airship/inspect")).length >
        looked.length,
      "the project is looked up again once the site is stopped"
    );
  });

  it("offers no stop while the site is not running", async () => {
    const { context } = mount({ browserTabsRegistered: true });
    const tree = await settled(context.bodies[PAGE_ID], {
      fetcher: fetcherFor({
        found: inspection({ command: "pnpm dev", port: 4321 }),
        running: [],
      }),
      sessionId: "session-1",
    });
    assert.equal(findButton(tree, "Stop the site"), null);
    assert.ok(findButton(tree, "Check again"));
    assert.ok(findButton(tree, "Open Airship"));
  });

  it("closes by port, and reattaches with takeover", async () => {
    const requests = [];
    const { context } = mount({ browserTabsRegistered: true });
    const tree = await settled(context.bodies[PAGE_ID], {
      fetcher: fetcherFor({
        opened: {
          json: () =>
            Promise.resolve({ mode: "canvas", url: "http://127.0.0.1:4322" }),
          ok: true,
          status: 200,
        },
        requests,
        running: [theirs],
      }),
      sessionId: "session-1",
    });
    const buttons = all(tree, "button");
    await buttons
      .find((b) => labelOf(b) === "Close that editor")
      .props.onClick();
    const close = requests.find((r) => r.url.endsWith("/airship/close"));
    assert.deepEqual(JSON.parse(close.init.body), { port: 4321 });

    await buttons
      .find((b) => labelOf(b) === "Use in this session")
      .props.onClick();
    const open = requests.find((r) => r.url.endsWith("/airship/open"));
    assert.deepEqual(JSON.parse(open.init.body), {
      mode: "inline",
      port: 4321,
      sessionId: "session-1",
      takeover: true,
    });
  });
});

describe("the window, arranged for an editor", () => {
  const PAGE_ID = "@provider-web-artisans/dsh-plugin/airship";
  const ours = {
    mode: "canvas",
    port: 3000,
    sessionId: "session-1",
    url: "http://127.0.0.1:3001",
  };

  function buttonsOf(tree) {
    const out = [];
    (function walk(node) {
      if (!node || typeof node !== "object") {
        return;
      }
      if (node.type === "button") {
        out.push(node);
      }
      for (const child of node.children ?? []) {
        walk(child);
      }
    })(tree);
    return out;
  }

  async function openFrom(context) {
    hookState.length = 0;
    const Page = context.bodies[PAGE_ID];
    const props = {
      fetcher: fetcherFor({
        opened: {
          json: () => Promise.resolve({ mode: "canvas", url: ours.url }),
          ok: true,
          status: 200,
        },
      }),
      sessionId: "session-1",
    };
    find(withOptions(Page, props), "input").props.onChange({
      target: { value: "3000" },
    });
    await find(render(Page(props)), "form").props.onSubmit({
      preventDefault: () => undefined,
    });
  }

  async function listed(context, running) {
    hookState.length = 0;
    const Page = context.bodies[PAGE_ID];
    const props = { fetcher: fetcherFor({ running }), sessionId: "session-1" };
    render(Page(props));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return { tree: render(Page(props)) };
  }

  it("takes the sessions sidebar and expands the right column when the editor opens", async () => {
    frameState.sidebarCollapsed = false;
    const { context } = mount({ browserTabsRegistered: true });
    await openFrom(context);
    assert.deepEqual(context.layoutCalls, [
      ["toggleSidebar"],
      ["setExpanded", "session-1", true],
    ]);
    assert.equal(frameState.sidebarCollapsed, true);
  });

  it("hides the header while arranged and the right column is open, through one stylesheet and a root attribute", async () => {
    frameState.sidebarCollapsed = false;
    styles.length = 0;
    rootAttributes.clear();
    const { context } = mount({ browserTabsRegistered: true });
    await openFrom(context);
    await openFrom(context);
    assert.equal(styles.length, 1, "the stylesheet is installed once");
    const rule = styles[0].textContent;
    // Keyed on the frame's own attribute, so the harness closing the right
    // column brings the header back, and opening it hides it again; and
    // everything but the corner (the layout controls) goes.
    assert.ok(
      rule.includes(
        "html[data-airship-arranged]:not(:has([data-rightbar-collapsed]))"
      ),
      rule
    );
    assert.ok(
      rule.includes(
        "div:has(> [data-conversation-header-corner]) > div:not([data-conversation-header-corner]) { opacity: 0; visibility: hidden; transition: opacity 180ms ease, visibility 0s linear 180ms; }"
      ),
      rule
    );
    // The fade in rides a transition on the plain groups, so it plays when
    // the mark comes off too, not only when the column closes.
    assert.ok(
      rule.includes(
        "\ndiv:has(> [data-conversation-header-corner]) > div:not([data-conversation-header-corner]) { transition: opacity 180ms ease; }"
      ) || rule.startsWith("div:has(> [data-conversation-header-corner])"),
      rule
    );
    assert.ok(rootAttributes.has("data-airship-arranged"));
  });

  it("marks the root by the host's list: set while this session has an editor, cleared when it has none", async () => {
    rootAttributes.clear();
    const { context } = mount({ browserTabsRegistered: true });
    await listed(context, [ours]);
    assert.ok(
      rootAttributes.has("data-airship-arranged"),
      "an editor listed for this session marks the root, with nothing opened from this page"
    );
    await listed(context, [{ ...ours, sessionId: "session-2" }]);
    assert.equal(
      rootAttributes.has("data-airship-arranged"),
      false,
      "an editor closed elsewhere clears the mark"
    );
  });

  it("leaves a sidebar that was already collapsed alone", async () => {
    frameState.sidebarCollapsed = true;
    const { context } = mount({ browserTabsRegistered: true });
    await openFrom(context);
    assert.deepEqual(context.layoutCalls, [["setExpanded", "session-1", true]]);
  });

  it("gives the sidebar back when the last editor of the session is closed", async () => {
    frameState.sidebarCollapsed = false;
    const { context } = mount({ browserTabsRegistered: true });
    await openFrom(context);
    context.layoutCalls.length = 0;
    const running = [ours];
    const { tree } = await listed(context, running);
    // After Close the host lists nothing: the same array, emptied, is what
    // the page's status call reads next.
    running.length = 0;
    await buttonsOf(tree)
      .find((b) => labelOf(b) === "Close the editor")
      .props.onClick();
    assert.deepEqual(context.layoutCalls, [["toggleSidebar"]]);
    assert.equal(frameState.sidebarCollapsed, false);
    assert.equal(rootAttributes.has("data-airship-arranged"), false);
  });

  it("offers fullscreen for this session's editor, and toggles it back", async () => {
    frameState.sidebarCollapsed = true;
    frameState.fullscreen = false;
    const { context } = mount({ browserTabsRegistered: true });
    const { tree } = await listed(context, [ours]);
    const full = buttonsOf(tree).find((b) => labelOf(b) === "Fullscreen");
    assert.ok(full, "this session's editor offers Fullscreen");
    full.props.onClick();
    frameState.fullscreen = true;
    full.props.onClick();
    assert.deepEqual(context.layoutCalls, [
      ["setMode", "session-1", "fullscreen"],
      ["setMode", "session-1", "push"],
    ]);
  });
});
