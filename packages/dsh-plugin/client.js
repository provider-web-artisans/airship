/**
 * Airship inside the DeepSeek Harness — the client half.
 *
 * An **Airship** page in the right sidebar, reached from the guide like the
 * Browser is: it looks the session's project up, and one button asks the
 * host's `POST /airship/open` to start the editor attached to the session on
 * screen, then puts it in a Browser tab. No model in that path.
 *
 * And the other direction: the editor, attached, keeps no chat of its own.
 * What it selects it posts to this window, and this half writes it into the
 * session's composer — so the person points in the editor and writes in the
 * one chat there is.
 *
 * A gesture rather than an automatic open, and that is deliberate. Every shipped
 * call site for the Browser tab is a click, because a tab opening itself takes
 * the right-hand column away from whatever the person was reading.
 *
 * Written as a browser module rather than a built bundle: it needs React and
 * nothing else, so `require('react')` from the module loader covers it and the
 * package stays two files with no build step.
 */
window.__ModuleLoader__.load({
  factory(require) {
    const React = require("react");

    // Nothing at module top level, on purpose. The desktop app serves every
    // client module of a profile as one combined classic script, so a
    // top-level `const` here shares a scope with every other plugin's — and a
    // second declaration of the same name is a SyntaxError that takes the whole
    // bundle down. Inside the factory each module has a scope of its own.
    /** The query parameter Airship reads to name the surface of one request. */
    const SURFACE_PARAM = "__airship";
    /** Airship's internal name for each launch surface. */
    const SURFACE_OF = { canvas: "shell", inline: "inline" };

    /**
     * The editor URL, marked as the surface it was launched with.
     *
     * Airship answers a top-level navigation with the editor and a framed one
     * with the app itself, because its own canvas reaches the app through a
     * frame. The Browser tab *is* a frame, so it asks for the surface it wants:
     * the parameter below is the first thing Airship's mode resolver reads, and
     * it wins over the framing headers. Which surface is the one the launch
     * chose — canvas unless it says inline — so `--mode inline` is not quietly
     * overridden. A URL that already carries a mode is left alone.
     *
     * @param url - the editor URL the host returned.
     * @param mode - `canvas` or `inline`; anything else means canvas.
     * @returns the same URL, naming the editor surface.
     */
    const editorSurfaceUrl = (url, mode) => {
      try {
        const marked = new URL(url);
        if (!marked.searchParams.has(SURFACE_PARAM)) {
          marked.searchParams.set(
            SURFACE_PARAM,
            SURFACE_OF[mode] ?? SURFACE_OF.canvas
          );
        }
        return marked.href;
      } catch {
        // Not a URL the parser accepts: hand it on untouched and let the tab
        // refuse it, rather than inventing an address here.
        return url;
      }
    };

    /**
     * Airship's mark, as the guide draws its entries: a square glyph on
     * `currentColor`. The same path as the editor's favicon, on the full
     * 24-box so it sits like the harness's own icons.
     */
    /** Airship's mark as an image, for CSS that cannot hold an element. */
    const AIRSHIP_MARK_URI =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 5.1L20 18.9H15.47L9.73 9.01ZM7.47 12.92H12L8.53 18.9H4Z'/%3E%3C/svg%3E";

    function AirshipIcon(props) {
      const size = props?.size ?? 24;
      return React.createElement(
        "svg",
        {
          "aria-hidden": true,
          className: props?.className,
          fill: "currentColor",
          height: size,
          viewBox: "0 0 24 24",
          width: size,
          xmlns: "http://www.w3.org/2000/svg",
        },
        React.createElement("path", {
          d: "M12 5.1L20 18.9H15.47L9.73 9.01ZM7.47 12.92H12L8.53 18.9H4Z",
        })
      );
    }

    /** The Airship page's identity in the tab system, and its kind. */
    const PAGE_ID = "@provider-web-artisans/dsh-plugin/airship";
    const PAGE_KIND = "airship";
    /** The route the host half registers; the page POSTs to it. */
    const OPEN_ROUTE = "/airship/open";
    /** The route that says what a launch would decide, before the click. */
    const INSPECT_ROUTE = "/airship/inspect";
    /** The route listing every editor the host supervises. */
    const STATUS_ROUTE = "/airship/status";
    /** The route that stops one editor. */
    const CLOSE_ROUTE = "/airship/close";
    /** The route that ends the site's dev server, whoever started it. */
    const STOP_ROUTE = "/airship/stop";
    /** Where the page remembers the last port per project. */
    const PORT_KEY = "airship.port";

    /**
     * The host's base for a same-app request, with the connection carrier's
     * null-origin fallback — the same rule the shipped open-in-app button uses.
     */
    const hostBase = () => {
      const origin = globalThis.location?.origin;
      return origin !== undefined && origin !== "null"
        ? origin
        : "http://dsh.internal";
    };

    /** The remembered ports, keyed by project directory. */
    const rememberedPorts = () => {
      try {
        const raw = localStorage.getItem(PORT_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    };

    const rememberPort = (cwd, port) => {
      try {
        localStorage.setItem(
          PORT_KEY,
          JSON.stringify({ ...rememberedPorts(), [cwd ?? ""]: port })
        );
      } catch {
        // Storage is a convenience; the page works without it.
      }
    };

    /** A selector hook that answers nothing, for a body handed no session store. */
    const useNoSessions = () => undefined;

    /**
     * Ask the host to open the editor.
     *
     * @param fetcher - the HTTP carrier, `fetch` unless a test says otherwise.
     * @param body - what the page collected.
     * @returns the host's answer: the editor URL and its surface.
     */
    async function requestOpen(fetcher, body) {
      return await post(fetcher, OPEN_ROUTE, body);
    }

    /** POST JSON to one of the host's routes and return its JSON answer. */
    async function post(fetcher, route, body) {
      const response = await fetcher(new URL(route, hostBase()), {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `HTTP ${String(response.status)}`
        );
      }
      return payload;
    }

    /** The editors the host is running, oldest first. */
    async function requestStatus(fetcher) {
      const response = await fetcher(new URL(STATUS_ROUTE, hostBase()), {
        headers: { accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      return Array.isArray(payload?.runs) ? payload.runs : [];
    }

    /** The port as a number, or null when the field does not hold one. */
    const portOf = (text) => {
      const number = Number(text);
      return Number.isInteger(number) && number > 0 && number <= 65_535
        ? number
        : null;
    };

    /** No tab information: a body rendered outside the sidebar kit. */
    const useNoTabInfo = () => ({ tab: undefined });

    /**
     * One line describing a selection, for the composer: what the element
     * is, where it is in the source, and what it says — enough for the model
     * on the other end to find it, and short enough to type after.
     *
     * @param message - what the editor posted.
     * @returns the line, without a trailing newline.
     */
    /** The last path segment, for a chip that has one line to say it in. */
    const basename = (file) =>
      String(file).split("/").filter(Boolean).pop() ?? file;

    /**
     * A selection as a composer chip: an atomic inline reference the person
     * can keep several of and delete one at a time, without it ever being
     * part of the text they type. The label is what the chip shows; the
     * clipboard text is what the message carries when sent — and it starts
     * with the source file as an `@` mention, so the harness's file
     * reference has the model read the file before it claims to know it.
     *
     * @param message - what the editor posted.
     * @returns the reference insert the composer takes.
     */
    /** The name this plugin's chips carry, and the `@` source that owns them. */
    const CHIP_SOURCE = "airship";

    /**
     * The chip's reference: what the composer keeps of a selection, and hands
     * back to this plugin's source when the chip is clicked or the draft is
     * sent. JSON, so it survives as text: the editor it came from, the
     * selection's name and place there (for a reveal), and enough of the
     * element and its source to write the words again.
     */
    function selectionRef(message) {
      const element = message.element ?? {};
      return JSON.stringify({
        editor: typeof message.editor === "string" ? message.editor : null,
        element: {
          classes: Array.isArray(element.classes)
            ? element.classes.filter(Boolean)
            : [],
          displayName: element.displayName ?? null,
          tagName: element.tagName ?? "element",
          textPreview:
            typeof element.textPreview === "string" ? element.textPreview : "",
        },
        id: typeof message.id === "string" ? message.id : null,
        path: typeof message.path === "string" ? message.path : null,
        source: message.source?.file
          ? { file: message.source.file, line: message.source.line ?? null }
          : null,
      });
    }

    /** The reference read back, or an empty one for text that is not ours. */
    function parseRef(ref) {
      try {
        const parsed = JSON.parse(ref);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    /**
     * The words for one reference: the label on the chip, and the sentence
     * the model receives (also the clipboard's). The sentence keeps the
     * `@file` mention in front, so the agent reads it as the file it is.
     */
    function selectionWords(parsed) {
      const element = parsed.element ?? {};
      const tag = element.tagName ?? "element";
      const classes = Array.isArray(element.classes)
        ? element.classes.filter(Boolean).join(".")
        : "";
      const what = `<${tag}${classes ? `.${classes}` : ""}>`;
      const name = element.displayName ? ` (${element.displayName})` : "";
      const file = parsed.source?.file;
      const line = parsed.source?.line ? `:${String(parsed.source.line)}` : "";
      const preview =
        typeof element.textPreview === "string" && element.textPreview.trim()
          ? ` \u2014 \u201c${element.textPreview.trim().slice(0, 80)}\u201d`
          : "";
      const where = file ? ` at ${file}${line}` : "";
      const sentence = `Airship selection: ${what}${name}${where}${preview}`;
      return {
        clipboardText: file ? `@${file} (${sentence})` : `(${sentence})`,
        label: file ? `${what} ${basename(file)}${line}` : what,
      };
    }

    function selectionChip(message) {
      const ref = selectionRef(message);
      const words = selectionWords(parseRef(ref));
      return {
        appearance: "file",
        clipboardText: words.clipboardText,
        label: words.label,
        ref,
        source: CHIP_SOURCE,
      };
    }

    /**
     * The `@` source that owns the chips. The composer expands every chip
     * through its owner's codec when the draft is sent, and refuses a draft
     * whose chips have no owner; this is the owner. It lists nothing in the
     * `@` menu — the editor is where selections are made — and a click on
     * a chip asks the editor to bring that element back into view.
     */
    function selectionSource(deps) {
      return {
        candidates: () => Promise.resolve([]),
        codec: {
          clipboardText: (ref) => selectionWords(parseRef(ref)).clipboardText,
          serialize: (ref) =>
            Promise.resolve(selectionWords(parseRef(ref)).clipboardText),
        },
        name: CHIP_SOURCE,
        onPick: () => undefined,
        openReference: (_session, reference) =>
          deps.reveal(parseRef(reference.ref)),
        showGroupTitle: false,
        trigger: "@",
      };
    }

    /** The message that asks the editor for a selection back. */
    const REVEAL_TYPE = "airship:reveal";

    /** How far from the chip's right edge its × reaches: the glyph, its gap and the padding. */
    const CHIP_REMOVE_ZONE_PX = 20;

    /**
     * The chip a click on its × names, with the composer root it sits in —
     * or null: a click anywhere else on the chip is the reveal, and a click
     * elsewhere is nobody's here.
     */
    function chipRemovalFor(event) {
      const host = event?.target?.closest?.(
        `[data-composer-chip="${CHIP_SOURCE}"]`
      );
      const rect = host?.firstElementChild?.getBoundingClientRect?.();
      if (!(host && rect) || typeof event.clientX !== "number") {
        return null;
      }
      if (event.clientX < rect.right - CHIP_REMOVE_ZONE_PX) {
        return null;
      }
      const root = host.closest?.("[data-composer-input]");
      return root ? { host, root } : null;
    }

    /**
     * Remove a chip the way a keystroke would. The composer offers no verb
     * for it, but its editor takes a `beforeinput` of `deleteContentBackward`
     * at the caret — and for that event it reads the caret from the
     * document — so the caret is put right after the chip and the event
     * dispatched on the editor's root. What the editor then deletes is the
     * chip, whole, as Backspace does.
     *
     * @returns whether the editor was asked; false when the chip has no place to put a caret after.
     */
    function removeChip({ host, root }, deps = {}) {
      const parent = host.parentNode;
      const index = parent
        ? Array.prototype.indexOf.call(parent.childNodes, host)
        : -1;
      const selection = deps.selection ?? window.getSelection?.();
      if (!(selection && index >= 0)) {
        return false;
      }
      root.focus?.();
      selection.setBaseAndExtent(parent, index + 1, parent, index + 1);
      const make =
        deps.inputEvent ?? ((type, init) => new InputEvent(type, init));
      root.dispatchEvent(
        make("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        })
      );
      return true;
    }

    /**
     * Watch the document's clicks, in the capture phase, so a click on a
     * chip's × is removed here and never reaches the composer's own click —
     * which would take it for the reveal.
     */
    function watchChipClicks(deps) {
      if (
        typeof document === "undefined" ||
        typeof document.addEventListener !== "function"
      ) {
        return () => undefined;
      }
      const onClick = (event) => {
        const removal = chipRemovalFor(event);
        if (!removal) {
          return;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        if (removeChip(removal, deps)) {
          deps.log?.("removed a chip from the composer");
        }
      };
      document.addEventListener("click", onClick, true);
      return () => {
        document.removeEventListener("click", onClick, true);
      };
    }

    /** A URL's origin, or null for text that is not a URL. */
    function originOf(url) {
      try {
        const { origin } = new URL(url);
        return origin;
      } catch {
        return null;
      }
    }

    /** The URL a `<webview>` shows: asked once it is ready, its `src` until then. */
    function webviewUrl(node) {
      try {
        const url = typeof node.getURL === "function" ? node.getURL() : "";
        if (url) {
          return url;
        }
      } catch {
        // Not attached yet; the attribute will have to do.
      }
      return frameUrl(node);
    }

    /** The URL an `<iframe>` (or a webview before it is ready) was given. */
    function frameUrl(node) {
      const { src } = node;
      return node.getAttribute?.("src") || src || null;
    }

    /**
     * The editor's surface in this document for an origin: the `<webview>`
     * the desktop app holds it in, or the `<iframe>` the web app does.
     */
    function editorSurfaceFor(origin) {
      if (typeof document === "undefined") {
        return null;
      }
      const showing = (nodes, read) =>
        [...nodes].find((node) => {
          const url = read(node);
          return typeof url === "string" && sameEditorOrigin(url, origin);
        });
      const webview = showing(
        document.querySelectorAll?.("webview") ?? [],
        webviewUrl
      );
      if (webview) {
        return { kind: "webview", node: webview };
      }
      const frame = showing(
        document.querySelectorAll?.("iframe") ?? [],
        frameUrl
      );
      return frame ? { kind: "iframe", node: frame } : null;
    }

    /**
     * Ask the editor a chip came from to bring its element back into view.
     * A `<webview>` is a separate web contents with no window to post to, but
     * its embedder may run script in it, so the message is posted from
     * inside; a frame is posted to directly.
     *
     * @returns whether an editor was asked; false leaves the click to the composer.
     */
    function revealInEditor(parsed, log) {
      const origin = originOf(parsed.editor);
      if (!(origin && (parsed.id || parsed.path))) {
        return false;
      }
      const surface = editorSurfaceFor(origin);
      if (!surface) {
        log?.(
          `no editor from ${origin} is showing here to reveal a selection in`
        );
        return false;
      }
      const message = {
        id: parsed.id ?? undefined,
        path: parsed.path ?? undefined,
        type: REVEAL_TYPE,
      };
      if (surface.kind === "webview") {
        const code = `window.postMessage(${JSON.stringify(message)}, "*")`;
        Promise.resolve(surface.node.executeJavaScript?.(code)).catch(
          (error) => {
            log?.(
              `the editor could not be asked to reveal a selection: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        );
      } else {
        surface.node.contentWindow?.postMessage(message, origin);
      }
      return true;
    }

    function selectionText(message) {
      const element = message.element ?? {};
      const tag = element.tagName ?? "element";
      const classes = Array.isArray(element.classes)
        ? element.classes.filter(Boolean).join(".")
        : "";
      const name = element.displayName ? ` (${element.displayName})` : "";
      const where = message.source?.file
        ? ` at ${message.source.file}${
            message.source.line ? `:${String(message.source.line)}` : ""
          }`
        : "";
      const preview =
        typeof element.textPreview === "string" && element.textPreview.trim()
          ? ` — \u201c${element.textPreview.trim().slice(0, 80)}\u201d`
          : "";
      return `Airship selection: <${tag}${classes ? `.${classes}` : ""}>${name}${where}${preview}`;
    }

    /**
     * A selection message from an editor this page opened goes into the
     * composer of the session that editor drives.
     *
     * Two checks before anything is written. The sender's origin has to be an
     * editor opened here — `postMessage` can come from any frame in the app,
     * and the message shape is public. And the draft is only ever *added to*:
     * a selection lands on its own line above whatever the person had typed,
     * replacing an earlier selection line so clicking around does not pile
     * them up.
     *
     * @param event - the window message event.
     * @param deps - how to map an origin to a session and a session to its composer.
     * @returns whether the composer was written.
     */
    /** The console prefix the editor announces a selection with. */
    const SELECTION_CONSOLE_PREFIX = "[airship:selected] ";

    /**
     * A selection announced on a guest's console, as the message it stands
     * for — or null for any other console line.
     *
     * The desktop app holds the Browser tab in an Electron `<webview>`, a
     * separate web contents where the editor is top-level and `postMessage`
     * has nobody to reach. What the embedder does get is every console line
     * the guest writes, as a `console-message` event on the element. The
     * editor writes one such line per selection (`attached.ts`), and this
     * turns it back into the event the frame path would have delivered: the
     * origin is the script's, which is the editor's own bundle.
     */
    function selectionFromConsole(text, sourceId) {
      if (
        typeof text !== "string" ||
        !text.startsWith(SELECTION_CONSOLE_PREFIX)
      ) {
        return null;
      }
      let data;
      try {
        data = JSON.parse(text.slice(SELECTION_CONSOLE_PREFIX.length));
      } catch {
        return null;
      }
      try {
        const { origin } = new URL(
          typeof sourceId === "string" && sourceId ? sourceId : data?.editor
        );
        return { data, origin };
      } catch {
        return null;
      }
    }

    /**
     * Listen to every `<webview>` in the document, present and future, for
     * the editor's console announcements. A no-op in a document without
     * webviews — the web app's Browser tab is an iframe, and `postMessage`
     * covers it.
     *
     * @param onSelection - what to do with a selection heard this way.
     * @returns a disposer.
     */
    function watchWebviews(onSelection) {
      if (
        typeof document === "undefined" ||
        typeof MutationObserver === "undefined"
      ) {
        return () => undefined;
      }
      const attached = new WeakSet();
      const listeners = new Map();
      const attach = (node) => {
        if (attached.has(node)) {
          return;
        }
        attached.add(node);
        const listener = (event) => {
          const heard = selectionFromConsole(event?.message, event?.sourceId);
          return heard ? onSelection(heard) : undefined;
        };
        listeners.set(node, listener);
        node.addEventListener("console-message", listener);
      };
      const scan = (root) => {
        if (root?.tagName?.toLowerCase?.() === "webview") {
          attach(root);
        }
        for (const node of root?.querySelectorAll?.("webview") ?? []) {
          attach(node);
        }
      };
      scan(document);
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            scan(node);
          }
        }
      });
      observer.observe(document.documentElement ?? document, {
        childList: true,
        subtree: true,
      });
      return () => {
        observer.disconnect();
        for (const [node, listener] of listeners) {
          node.removeEventListener("console-message", listener);
        }
      };
    }

    async function receiveSelection(event, deps) {
      const data = event?.data;
      if (data?.type !== "airship:selected") {
        return false;
      }
      const sessionId = await deps.sessionFor(event.origin);
      if (!sessionId) {
        deps.log?.(
          `ignored a selection from ${event.origin}: no editor of ours has that origin`
        );
        return false;
      }
      const composer = deps.composerFor(sessionId);
      if (!composer) {
        deps.log?.(
          `ignored a selection for ${sessionId}: that session has no composer here`
        );
        return false;
      }
      const state = inputState(composer);
      const current = typeof state.draft === "string" ? state.draft : "";
      const asChip = writeChip(composer, state, current, data, deps.log);
      if (asChip) {
        deps.log?.(`${asChip} ${sessionId}'s composer`);
        return true;
      }
      const line = writeLine(composer, current, data);
      deps.log?.(`wrote a selection into ${sessionId}'s composer: ${line}`);
      return true;
    }

    /**
     * The composer's published state: the draft as text and its revision,
     * which a chip insert has to quote back. The store is a `SnapshotStore`,
     * read with `getSnapshot`; `get` is kept as a fallback for a store shaped
     * otherwise, and either way a missing store reads as empty.
     */
    function inputState(composer) {
      const store = composer.state;
      if (!store) {
        return {};
      }
      if (typeof store.getSnapshot === "function") {
        return store.getSnapshot() ?? {};
      }
      if (typeof store.get === "function") {
        return store.get() ?? {};
      }
      return {};
    }

    /**
     * A chip when the composer takes one: atomic, several at a time, each
     * deletable on its own, never part of the typed text. The same element
     * twice is one chip. Inserted at the front, so the text the person is
     * typing stays where it is.
     *
     * @returns what happened, for the log, or null when the composer took no
     * chip and the caller should write text instead.
     */
    function writeChip(composer, state, current, data, log) {
      if (typeof composer.insertReference !== "function") {
        return null;
      }
      const chip = selectionChip(data);
      if (current.includes(chip.clipboardText)) {
        return `${chip.label} was already in`;
      }
      const applied = composer.insertReference(chip, {
        draftRev: typeof state.draftRev === "number" ? state.draftRev : 0,
        end: 0,
        start: 0,
      });
      if (applied) {
        return `added a chip (${chip.label}) to`;
      }
      log?.(
        "the composer refused a chip (busy, or the draft moved); writing text instead"
      );
      return null;
    }

    /**
     * The text form: one line at the top of the draft, replacing an earlier
     * selection line so clicking around does not pile them up.
     *
     * @returns the line written.
     */
    function writeLine(composer, current, data) {
      const line = selectionText(data);
      const kept = current
        .split("\n")
        .filter((l) => !l.startsWith("Airship selection: "));
      while (kept.length > 0 && kept[0] === "") {
        kept.shift();
      }
      const rest = kept.join("\n");
      composer.setDraft(rest ? `${line}\n${rest}` : `${line}\n`);
      return line;
    }

    /**
     * Whether two origins name the same loopback server. The host reports an
     * editor as `http://localhost:4323` while the frame that loaded it may
     * say `http://127.0.0.1:4323`; both are this machine, and the port is
     * what tells editors apart.
     */
    function sameEditorOrigin(a, b) {
      if (a === b) {
        return true;
      }
      try {
        const x = new URL(a);
        const y = new URL(b);
        const loopback = (host) =>
          host === "localhost" || host === "127.0.0.1" || host === "[::1]";
        return (
          x.protocol === y.protocol &&
          x.port === y.port &&
          loopback(x.hostname === "::1" ? "[::1]" : x.hostname) &&
          loopback(y.hostname === "::1" ? "[::1]" : y.hostname)
        );
      } catch {
        return false;
      }
    }

    /**
     * The page's look-up, outside the component so it reads as one step:
     * ask, publish what came back, and prefill what the person has not typed.
     *
     * @param page - the page's setters, its fetcher, and whether it is live.
     */
    async function lookUp(page) {
      if (!page.sessionId) {
        page.setFound({ kind: "failed", text: "Open a session first." });
        return;
      }
      page.setFound({ kind: "looking" });
      let inspection;
      try {
        inspection = await requestInspection(page.fetcher, page.sessionId);
      } catch (error) {
        if (page.live()) {
          page.setFound({
            kind: "failed",
            text: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (!page.live()) {
        return;
      }
      page.setFound({ inspection, kind: "found" });
      const launch = inspection.launch ?? {};
      if (!launch.error) {
        page.setPort((current) => current || String(launch.port));
        page.setCommand((current) => current || launch.command || "");
      }
    }

    /**
     * Ask the host what a launch for this session would decide.
     *
     * @param fetcher - the HTTP carrier.
     * @param sessionId - the session on screen.
     * @returns the inspection, with the host's `launch` choice.
     */
    async function requestInspection(fetcher, sessionId) {
      const url = new URL(INSPECT_ROUTE, hostBase());
      url.searchParams.set("sessionId", sessionId);
      const response = await fetcher(url, {
        headers: { accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `HTTP ${String(response.status)}`
        );
      }
      return payload;
    }

    /**
     * Show the editor from a tab, so it lands in that tab's session. The
     * tab's own action is bound to its session; the global opener, which
     * reads whichever session is mounted now, is only the fallback for a
     * body rendered without tab information.
     */
    function showEditor(url, editorMode, props, tab) {
      props.remember?.(url, props.sessionId);
      props.arrange?.(props.sessionId);
      if (tab?.actions?.openTab) {
        tab.actions.openTab("browser", {
          params: { url: props.surfaceUrl(url, editorMode) },
        });
        return;
      }
      props.open(url, editorMode, props.sessionId);
    }

    /**
     * What a launch's outcome does to the page, if the page is still there:
     * an error line, or the running state and the editor shown — with the
     * surface the host answered, not the one the form asked for, since an
     * editor already running on that port keeps its own.
     */
    function settleLaunch(outcome, live, setState, show) {
      if (!live()) {
        return;
      }
      if (outcome.error) {
        setState({ kind: "error", text: outcome.error });
        return;
      }
      setState({ kind: "running", mode: outcome.mode, url: outcome.url });
      show(outcome.url, outcome.mode);
    }

    /** What the form is missing, or null when it can be sent. */
    function formComplaint(number, sessionId) {
      if (number === null) {
        return "Enter the dev server's port.";
      }
      return sessionId ? null : "Open a session first.";
    }

    /** Re-read the host's list; a list that cannot be read stays as it was. */
    async function refreshEditors(fetcher, live, setRunning) {
      const runs = await requestStatus(fetcher).catch(() => null);
      if (runs && live()) {
        setRunning(runs);
      }
    }

    /** Ask the host for the editor; the outcome, either way, as `settle` takes it. */
    async function launchEditor(fetcher, body) {
      try {
        const payload = await requestOpen(fetcher, body);
        return { mode: payload.mode, url: payload.url };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    /**
     * Stop one editor, then show the list as it is now. The window was
     * arranged for an editor of this session; with none of them left, the
     * person gets their sidebar back.
     */
    async function closeEditor(number, page) {
      try {
        await post(page.fetcher, CLOSE_ROUTE, { port: number });
      } catch (error) {
        if (page.live()) {
          page.setState({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const left = await requestStatus(page.fetcher).catch(() => []);
      if (page.live()) {
        page.setRunning(left);
      }
      if (!left.some((run) => run.sessionId === page.sessionId)) {
        page.restore?.();
      }
    }

    /** The running list before the host has been asked: nothing is known. */
    const NOT_LISTED = [];

    /**
     * End the site's dev server on that port — the editor on it too, if
     * there is one — then look the project up again, so the page says what
     * pressing Open will do now (start it). A site that hung is the reason
     * this exists; the host only touches processes working inside the
     * project, and says so when it left one alone.
     */
    async function stopSite(number, page) {
      page.setState({ kind: "stopping" });
      try {
        await post(page.fetcher, STOP_ROUTE, {
          port: number,
          sessionId: page.sessionId,
        });
        if (page.live()) {
          page.setState({ kind: "idle" });
        }
      } catch (error) {
        if (page.live()) {
          page.setState({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const left = await requestStatus(page.fetcher).catch(() => []);
      if (page.live()) {
        page.setRunning(left);
      }
      if (!left.some((run) => run.sessionId === page.sessionId)) {
        page.restore?.();
      }
      await page.look();
    }

    function AirshipPage(props) {
      const useSessions = props.useSessions ?? useNoSessions;
      const useTabInfo = props.useTabInfo ?? useNoTabInfo;
      const cwd = useSessions(
        (sessions) => sessions?.byId?.[props.sessionId]?.cwd
      );
      const { tab } = useTabInfo();
      const [port, setPort] = React.useState(
        () => rememberedPorts()[cwd ?? ""] ?? ""
      );
      const [command, setCommand] = React.useState("");
      const [mode, setMode] = React.useState("inline");
      const [state, setState] = React.useState({ kind: "idle" });
      /** What the host is running; refreshed with every look-up and action. */
      const [running, setRunning] = React.useState(NOT_LISTED);
      const refreshRunning = () =>
        refreshEditors(fetcher, () => mounted.current, setRunning);
      /** What the host found: `{ kind: "looking" | "found" | "failed", ... }`. */
      const [found, setFound] = React.useState({ kind: "looking" });
      const fetcher = props.fetcher ?? ((input, init) => fetch(input, init));

      // Whether this page is still on screen. A launch can take a while, and
      // the person may have moved to another session by the time it answers:
      // opening the editor then would put it in *that* session's sidebar,
      // driving a conversation the person is no longer looking at.
      const mounted = React.useRef(true);
      React.useEffect(
        () => () => {
          mounted.current = false;
        },
        []
      );

      /**
       * Look the project up, and prefill the form from the answer: the port
       * the host would pick, and the start command only when nothing is
       * listening — a server that is already up must not be started twice.
       * A remembered port outranks the guess; the person chose it once.
       */
      const look = () => {
        refreshRunning();
        return lookUp({
          fetcher,
          live: () => mounted.current,
          sessionId: props.sessionId,
          setCommand,
          setFound,
          setPort,
        });
      };
      // Once, when the page opens for a session; `look` is redone by the
      // Check-again control, not by re-renders. The stylesheet the page's
      // controls hover with goes in at the same time.
      React.useEffect(() => {
        installStyle();
        look();
      }, [props.sessionId]);

      /**
       * Show the editor from this tab, so it lands in this tab's session.
       * The tab's own action is bound to its session; the global opener,
       * which reads whichever session is mounted now, is only the fallback
       * for a body rendered without tab information.
       */
      const show = (url, editorMode) => showEditor(url, editorMode, props, tab);

      /** Still worth acting on: the page is on screen and its tab is alive. */
      const live = () => mounted.current && !tab?.signal?.aborted;

      const complaint = (number) => formComplaint(number, props.sessionId);

      const settle = (outcome) => settleLaunch(outcome, live, setState, show);

      /**
       * Open, or with `takeover` reattach: the editor on that port stops
       * driving whatever session it drove and is started again for this one.
       */
      const launch = async (number, takeover) => {
        setState({ kind: "starting" });
        settle(
          await launchEditor(fetcher, {
            command: command.trim() || undefined,
            mode,
            port: number,
            sessionId: props.sessionId,
            takeover,
          })
        );
        rememberPort(cwd, number);
        refreshRunning();
      };

      const submit = async (event) => {
        event?.preventDefault?.();
        const number = portOf(port);
        const missing = complaint(number);
        if (missing) {
          setState({ kind: "error", text: missing });
          return;
        }
        await launch(number, false);
      };

      const close = (number) =>
        closeEditor(number, {
          fetcher,
          live: () => mounted.current,
          restore: props.restore,
          sessionId: props.sessionId,
          setRunning,
          setState,
        });

      const stop = (number) =>
        stopSite(number, {
          fetcher,
          live: () => mounted.current,
          look,
          restore: props.restore,
          sessionId: props.sessionId,
          setRunning,
          setState,
        });

      const [optionsOpen, setOptionsOpen] = React.useState(false);
      const mine = running.find((run) => run.sessionId === props.sessionId);
      const others = running.filter((run) => run.sessionId !== props.sessionId);
      // The window is marked as arranged exactly while this session has an
      // editor, by the host's list — not by this page's memory of opening
      // one, which a reload, or an editor closed elsewhere, would outdate.
      React.useEffect(() => {
        if (running !== NOT_LISTED) {
          props.mark?.(mine !== undefined);
        }
      }, [running, mine, props.mark]);
      return renderPage({
        close,
        command,
        cwd,
        found,
        fullscreen: props.fullscreenFor
          ? () => props.fullscreenFor(props.sessionId)
          : undefined,
        look,
        mine,
        mode,
        optionsOpen,
        others,
        port,
        reattach: (number) => launch(number, true),
        setCommand,
        setMode,
        setOptionsOpen,
        setPort,
        show,
        state,
        stop,
        submit,
      });
    }

    // -- The page's look, in the harness's own parts ------------------------
    //
    // The harness ships its primitives as a module in the same graph, so the
    // page is drawn with its buttons, inputs, state dots, glyphs and tooltips
    // and inherits its tokens. A composition without them (the tests, an
    // older web profile) falls back to plain elements that read the same
    // tokens by name.
    let primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch {
      primitives = null;
    }
    const h = React.createElement;
    /** React children as a list, however the caller passed them. */
    const asChildren = (children) =>
      Array.isArray(children) ? children : [children];
    const Button =
      primitives?.Button ??
      (({ variant, size, icon, children, ...rest }) =>
        h(
          "button",
          {
            type: "button",
            ...rest,
            "data-variant": variant ?? "ghost",
            style: {
              background:
                variant === "primary"
                  ? "var(--dsw-alias-button-info-fill, #2f6fed)"
                  : "transparent",
              border:
                variant === "outline"
                  ? "1px solid var(--dsw-alias-border-l4, currentColor)"
                  : "none",
              borderRadius: "14px",
              color:
                variant === "primary"
                  ? "#fff"
                  : "var(--dsw-alias-label-primary, inherit)",
              cursor: rest.disabled ? "default" : "pointer",
              font: "inherit",
              padding: size === "sm" ? "4px 10px" : "8px 14px",
            },
          },
          ...asChildren(children)
        ));
    const Input =
      primitives?.Input ?? (({ icon, className, ...rest }) => h("input", rest));
    const StateDot =
      primitives?.StateDot ??
      (({ state }) =>
        h("span", {
          "data-state": state,
          style: {
            background: "currentColor",
            borderRadius: "50%",
            display: "inline-block",
            height: "8px",
            width: "8px",
          },
        }));
    const PathLabel =
      primitives?.PathLabel ?? (({ path }) => h("code", null, path));
    const SegmentedControl =
      primitives?.SegmentedControl ??
      (({ id, value, options, onChange, label }) =>
        h(
          "select",
          {
            "aria-label": label,
            id,
            onChange: (e) => onChange(e.target.value),
            value,
          },
          ...options.map((o) => h("option", { value: o.value }, o.label))
        ));
    const DisclosureRow =
      primitives?.DisclosureRow ??
      (({ title, open, onToggle, children }) =>
        h(
          "div",
          null,
          h(
            "button",
            { "aria-expanded": open, onClick: onToggle, type: "button" },
            title
          ),
          ...(open ? asChildren(children) : [])
        ));
    /** A hover label on one element; without the kit, the element alone. */
    const Tooltip =
      primitives?.Tooltip ?? (({ children }) => asChildren(children)[0]);
    /**
     * One of the harness's glyphs, by name — they take `size` and draw in
     * currentColor — or, without the kit, a character of the same footprint.
     */
    const glyph = (name, mark) =>
      primitives?.[name] ??
      ((props) =>
        h(
          "span",
          {
            "aria-hidden": "true",
            style: {
              display: "inline-block",
              fontSize: "12px",
              lineHeight: `${String(props?.size ?? 16)}px`,
              textAlign: "center",
              width: `${String(props?.size ?? 16)}px`,
            },
          },
          mark
        ));
    const IconPlay = glyph("IconPlayOutlineRegular", "▶");
    const IconStop = glyph("IconStopFillRegular", "■");
    const IconRefresh = glyph("IconRefreshOutlineRegular", "↻");
    const IconFullscreen = glyph("IconFullscreenOutlineRegular", "⛶");
    const IconClose = glyph("IconCloseOutlineRegular", "✕");
    const IconShow = glyph("IconRightUpOutlineRegular", "↗");
    const IconPin = glyph("IconPinOutlineRegular", "⌖");
    const IconSliders = glyph("IconSlidersTwoOutlineRegular", "≡");

    /**
     * The mark on the document root while the window is arranged for an
     * editor, and the stylesheet that reads it.
     *
     * With the editor beside it the chat column is narrow, and the header —
     * the title, the mode and team actions, the utilities — overlaps itself.
     * They are the harness's and other plugins' contributions, which this
     * one cannot take out, so the stylesheet fades the header's groups, all
     * but the corner with the layout controls, while the window is arranged
     * and only while the right column is open. The frame publishes
     * `data-rightbar-collapsed` when the column is closed, so closing it —
     * by any means, not only this plugin's Close — brings the header back,
     * and opening it again takes it away again. The groups have no
     * attributes of their own; the corner does, so they are named relative
     * to it, without hashed class names.
     */
    const ARRANGED = "data-airship-arranged";
    const HEADER_GROUPS =
      "div:has(> [data-conversation-header-corner])" +
      " > div:not([data-conversation-header-corner])";
    const HEADER_HIDDEN_WHEN = `html[${ARRANGED}]:not(:has([data-rightbar-collapsed])) ${HEADER_GROUPS}`;
    /** How long the header takes to fade, either way. */
    const FADE_MS = 180;
    const STYLE_ID = "@provider-web-artisans/dsh-plugin";
    /** The plugin's one stylesheet, installed once, whoever asks first. */
    const installStyle = () => {
      if (typeof document === "undefined" || !document.head?.appendChild) {
        return;
      }
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) {
        return;
      }
      const tag = document.createElement("style");
      tag.dataset.plugin = "@provider-web-artisans/dsh-plugin";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = [
        // The groups fade rather than vanish: opacity carries the fade, and
        // visibility, switched once it is done, takes them away from the
        // pointer. Shown again, visibility returns at once under the fade
        // in. The transition lives on the plain rule so the fade in happens
        // when the mark comes off, not only when the column closes.
        `${HEADER_GROUPS} { transition: opacity ${String(FADE_MS)}ms ease; }`,
        `${HEADER_HIDDEN_WHEN} { opacity: 0; visibility: hidden; transition: opacity ${String(FADE_MS)}ms ease, visibility 0s linear ${String(FADE_MS)}ms; }`,
        // The page's icon buttons hover like the harness's own; a hover is
        // nothing an inline style can say.
        "[data-airship-icon-button]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
        "[data-airship-icon-button]:disabled { cursor: default; opacity: 0.4; }",
        // This plugin's chips in the composer: the chip host carries the
        // source's name, so ours get a pill of their own — Airship's mark in
        // place of the file glyph the harness draws for the appearance the
        // chip has to declare, on a tint that reads as a pill without hover.
        `[data-composer-chip="${CHIP_SOURCE}"] > span { background: var(--dsw-alias-state-business-tertiary); border-radius: 6px; cursor: pointer; padding: 0 6px 0 4px; }`,
        `[data-composer-chip="${CHIP_SOURCE}"] > span > svg { display: none; }`,
        `[data-composer-chip="${CHIP_SOURCE}"] > span::before { align-self: center; background: currentColor; content: ""; flex: none; height: 14px; width: 14px; -webkit-mask: url("${AIRSHIP_MARK_URI}") center / contain no-repeat; mask: url("${AIRSHIP_MARK_URI}") center / contain no-repeat; }`,
        // The × at the right removes the chip (`watchChipClicks`); a click
        // anywhere else on it is the reveal.
        `[data-composer-chip="${CHIP_SOURCE}"] > span::after { content: "\\00d7"; flex: none; font-weight: 500; margin-left: 2px; opacity: 0.55; }`,
        `[data-composer-chip="${CHIP_SOURCE}"] > span:hover::after { opacity: 1; }`,
      ].join("\n");
      document.head.appendChild(tag);
    };
    const markArranged = (on) => {
      const root =
        typeof document === "undefined" ? null : document.documentElement;
      if (!root?.setAttribute) {
        return;
      }
      if (on) {
        root.setAttribute(ARRANGED, "");
      } else {
        root.removeAttribute(ARRANGED);
      }
    };

    // The grid of the harness's own flow rows (its DisclosureRow): a 16px
    // leading box, then 6px, then the words. Every row of the page sits on
    // it, so the dots, the Options chevron and the controls line up.
    const LEADING_WIDTH = "16px";
    const LEADING_GAP = "6px";
    const TEXT_INSET = "22px";

    const typeface = {
      fontFamily: "var(--dsw-font-family, inherit)",
    };
    const muted = {
      ...typeface,
      color: "var(--dsw-alias-label-tertiary, inherit)",
      fontSize: "12px",
    };
    const bodyText = {
      ...typeface,
      color: "var(--dsw-alias-label-secondary, inherit)",
      fontSize: "13px",
      lineHeight: "20px",
    };

    /**
     * One row of the page: the leading box, the words, and the row's
     * controls at the right. The controls never wrap; the words do.
     */
    function row({ leading, body, actions = [], attrs = {}, align }) {
      const { style, ...rest } = attrs;
      return h(
        "div",
        {
          ...rest,
          style: {
            alignItems: align ?? "center",
            display: "flex",
            gap: LEADING_GAP,
            minHeight: "28px",
            ...style,
          },
        },
        h(
          "span",
          {
            style: {
              alignItems: "center",
              color: "var(--dsw-alias-label-tertiary, inherit)",
              display: "inline-flex",
              flex: "none",
              height: "24px",
              justifyContent: "center",
              width: LEADING_WIDTH,
            },
          },
          leading
        ),
        h(
          "div",
          { style: { ...bodyText, flex: "1 1 auto", minWidth: 0 } },
          ...asChildren(body)
        ),
        actions.length > 0
          ? h(
              "div",
              {
                style: {
                  alignItems: "center",
                  display: "flex",
                  flex: "none",
                  gap: "2px",
                  marginLeft: "6px",
                },
              },
              ...actions
            )
          : null
      );
    }

    /**
     * A 28px round icon button with a hover label, the shape of the
     * harness's own header controls. The label is also what a screen
     * reader says, and the native title where the kit's tooltip is missing.
     */
    function IconButton({ label, icon, ...rest }) {
      return h(
        Tooltip,
        { delayMs: 500, label, side: "bottom" },
        h(
          "button",
          {
            "aria-label": label,
            ...(primitives?.Tooltip ? {} : { title: label }),
            "data-airship-icon-button": "",
            type: "button",
            ...rest,
            style: {
              alignItems: "center",
              background: "transparent",
              border: "none",
              borderRadius: "50%",
              color: "var(--dsw-alias-label-secondary, inherit)",
              cursor: "pointer",
              display: "inline-flex",
              flex: "none",
              height: "28px",
              justifyContent: "center",
              padding: 0,
              width: "28px",
            },
          },
          h(icon, { size: 16 })
        )
      );
    }

    /** A labelled field, the way the harness's settings lay them out. */
    const field = (label, control) =>
      h(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: "6px" } },
        h("span", { style: muted }, label),
        control
      );

    /**
     * What the look-up says, in the person's terms: whether their site is
     * running, and what pressing Open will do about it.
     *
     * @returns the dot's state, the words, and the port when the site answers.
     */
    function siteStatus(found, state) {
      if (state.kind === "stopping") {
        return { state: "ongoing", text: "Stopping your site…" };
      }
      if (found.kind === "looking") {
        return { state: "ongoing", text: "Checking your project…" };
      }
      if (found.kind === "failed") {
        return {
          detail: `— ${found.text}`,
          state: "error",
          text: "Couldn't check the project",
        };
      }
      const launch = found.inspection?.launch ?? {};
      if (launch.error) {
        return {
          detail:
            "— and there is no command to start it. Set one under Options.",
          state: "warning",
          text: "Your site isn't running",
        };
      }
      if (launch.command) {
        return {
          detail: `— Airship will run “${launch.command}” on port ${String(launch.port)} when it opens.`,
          state: "warning",
          text: "Your site isn't running yet",
        };
      }
      return {
        detail: `on port ${String(launch.port)}.`,
        port: launch.port,
        state: "done",
        text: "Your site is running",
      };
    }

    /** The page, drawn from what the component decided. */
    function renderPage(view) {
      return h(
        "form",
        {
          onSubmit: view.submit,
          style: {
            ...typeface,
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            maxWidth: "520px",
            padding: "16px 20px 24px",
          },
        },
        projectRow(view),
        siteRow(view),
        view.mine ? mineRow(view) : null,
        ...view.others.map((run) => otherRow(view, run)),
        errorRow(view),
        optionsRow(view)
      );
    }

    /** The project: Airship's mark, its name, and where it is. */
    function projectRow(view) {
      const name =
        view.found.inspection?.name ??
        (view.cwd ? basename(view.cwd) : "This project");
      return row({
        align: "flex-start",
        attrs: { style: { marginBottom: "8px" } },
        body: [
          h(
            "div",
            {
              style: {
                color: "var(--dsw-alias-label-primary, inherit)",
                fontSize: "15px",
                fontWeight: 600,
                lineHeight: "24px",
              },
            },
            name
          ),
          view.cwd ? h(PathLabel, { path: view.cwd, style: muted }) : null,
        ],
        leading: h(AirshipIcon, { size: 16 }),
      });
    }

    /**
     * The site's row: its state in a sentence, and what can be done about
     * it — stop it while it answers, look again, and, until this session
     * has an editor, the one thing the page is for.
     */
    function siteRow(view) {
      const status = siteStatus(view.found, view.state);
      const busy =
        view.found.kind === "looking" ||
        view.state.kind === "stopping" ||
        view.state.kind === "starting";
      const actions = [];
      if (status.port !== undefined) {
        actions.push(
          h(IconButton, {
            disabled: busy,
            icon: IconStop,
            key: "stop",
            label: "Stop the site",
            onClick: () => view.stop(status.port),
          })
        );
      }
      actions.push(
        h(IconButton, {
          disabled: busy,
          icon: IconRefresh,
          key: "look",
          label: "Check again",
          onClick: () => view.look(),
        })
      );
      if (!view.mine) {
        actions.push(
          h(
            Button,
            {
              disabled: busy,
              icon: h(IconPlay, { size: 16 }),
              key: "open",
              size: "sm",
              style: { marginLeft: "4px" },
              type: "submit",
              variant: "primary",
            },
            view.state.kind === "starting" ? "Starting…" : "Open Airship"
          )
        );
      }
      return row({
        actions,
        attrs: { "data-found": view.found.kind },
        body: [
          status.text,
          status.detail
            ? h("span", { style: muted }, ` ${status.detail}`)
            : null,
        ],
        leading: h(StateDot, { state: status.state }),
      });
    }

    /** How the editor shows the page, in the Options' words. */
    const surfaceName = (mode) =>
      mode === "canvas" ? "on a canvas" : "on the page";

    /** This session's editor: where it shows, and the three things to do with it. */
    function mineRow(view) {
      const run = view.mine;
      return row({
        actions: [
          h(IconButton, {
            icon: IconShow,
            key: "show",
            label: "Show the editor",
            onClick: () => view.show(run.url, run.mode),
          }),
          view.fullscreen
            ? h(IconButton, {
                icon: IconFullscreen,
                key: "full",
                label: "Fullscreen",
                onClick: view.fullscreen,
              })
            : null,
          h(IconButton, {
            icon: IconClose,
            key: "close",
            label: "Close the editor",
            onClick: () => view.close(run.port),
          }),
        ],
        attrs: { "data-port": String(run.port) },
        body: [
          "Airship is open for this session",
          h(
            "span",
            { style: muted },
            ` — ${surfaceName(run.mode)}, port ${String(run.port)}.`
          ),
        ],
        leading: h(StateDot, { state: "done" }),
      });
    }

    /**
     * An editor another session holds: whose, where, and the two things that
     * can be done with it from here — take it for this session, or stop it.
     */
    function otherRow(view, run) {
      const where = run.cwd ? `, ${basename(run.cwd)}` : "";
      return row({
        actions: [
          h(IconButton, {
            icon: IconPin,
            key: "use",
            label: "Use in this session",
            onClick: () => view.reattach(run.port),
          }),
          h(IconButton, {
            icon: IconClose,
            key: "close",
            label: "Close that editor",
            onClick: () => view.close(run.port),
          }),
        ],
        attrs: { "data-port": String(run.port) },
        body: [
          "Open in another session",
          h(
            "span",
            { style: muted, title: run.cwd },
            ` — ${whoseEditor(run.sessionId)}, port ${String(run.port)}${where}.`
          ),
        ],
        leading: h(StateDot, { state: "idle" }),
      });
    }

    /** Another session's editor, named by the start of its id. */
    const whoseEditor = (sessionId) =>
      sessionId ? `session ${sessionId.slice(0, 8)}…` : "no session";

    /** What went wrong, when something did. */
    function errorRow(view) {
      if (view.state.kind !== "error") {
        return null;
      }
      return row({
        attrs: { "data-error": "" },
        body: h(
          "span",
          { style: { color: "var(--dsw-alias-state-error-primary, inherit)" } },
          view.state.text
        ),
        leading: h(StateDot, { state: "error" }),
      });
    }

    /** The details, behind a disclosure on the same grid, for whoever needs them. */
    function optionsRow(view) {
      return h(
        "div",
        { style: { marginTop: "8px" } },
        h(
          DisclosureRow,
          {
            expandable: true,
            expandOnRowClick: true,
            icon: h(IconSliders, { size: 14 }),
            onToggle: () => view.setOptionsOpen(!view.optionsOpen),
            open: view.optionsOpen,
            title: "Options",
          },
          h(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                padding: `8px 0 4px ${TEXT_INSET}`,
              },
            },
            field(
              "Port your site runs on",
              h(Input, {
                inputMode: "numeric",
                onChange: (e) => view.setPort(e.target.value),
                placeholder: "4321",
                value: view.port,
              })
            ),
            field(
              "Command that starts it, if it isn't running",
              h(Input, {
                onChange: (e) => view.setCommand(e.target.value),
                placeholder: "pnpm dev",
                value: view.command,
              })
            ),
            field(
              "How the editor shows the page",
              h(SegmentedControl, {
                id: "airship-surface",
                label: "How the editor shows the page",
                onChange: view.setMode,
                options: [
                  { label: "On the page", value: "inline" },
                  { label: "On a canvas", value: "canvas" },
                ],
                value: view.mode,
              })
            )
          )
        )
      );
    }

    return {
      apply(ctx) {
        // The `@` source that owns the chips: without it the composer would
        // refuse to send a draft holding one. Its own inject, so a profile
        // without the trigger service still gets the page and the bridge.
        ctx.inject?.(["inputTriggers"], (scope) => {
          scope.effect(
            () =>
              scope.inputTriggers.registerSource(
                selectionSource({
                  reveal: (parsed) => revealInEditor(parsed, log),
                })
              ),
            "airship: @ source"
          );
        });
        /**
         * Show the editor in the sidebar's Browser tab when the profile mounts
         * one, and hand the URL to the browser when it does not.
         *
         * The tab type is a package of its own, so a composition can leave it
         * out — a bare `web` profile does, while the desktop app mounts it. The
         * check is the shipped one: ask the tab registry, and fall back rather
         * than throwing inside a click handler where nobody would see it.
         *
         * @param url - the editor URL the tool returned.
         */
        /** Editor origins this page opened, and the session each drives. */
        const editors = new Map();

        /**
         * The window, arranged for an editor: the sessions sidebar out of the
         * way and the right column expanded, so the chat and the editor share
         * the width. The app frame says what it is showing on its `data-`
         * attributes (set only while true), which is how a toggle is only
         * sent when it changes something — and how the sidebar is only given
         * back if this plugin took it.
         */
        // Remembered in session storage rather than a variable: this module
        // is reloaded on every edit while developing, and a flag held in a
        // closure would forget, between an open and its close, that the
        // sidebar was taken — and never give it back.
        const TAKEN_KEY = "airship.sidebarTaken";
        const sidebarTaken = () => {
          try {
            return sessionStorage.getItem(TAKEN_KEY) === "1";
          } catch {
            return false;
          }
        };
        const setSidebarTaken = (on) => {
          try {
            if (on) {
              sessionStorage.setItem(TAKEN_KEY, "1");
            } else {
              sessionStorage.removeItem(TAKEN_KEY);
            }
          } catch {
            // Without storage the flag lives only as long as this module.
          }
        };
        const frameHas = (attribute) =>
          typeof document !== "undefined" &&
          document.querySelector(`[${attribute}]`) !== null;
        const arrange = (sessionId) => {
          installStyle();
          markArranged(true);
          const layout = ctx.get("layout");
          if (layout && !frameHas("data-sidebar-collapsed")) {
            layout.toggleSidebar();
            setSidebarTaken(true);
          }
          const actions = ctx.sidebarRight?.actions;
          if (sessionId && typeof actions?.setExpanded === "function") {
            actions.setExpanded(sessionId, true);
          }
        };
        const restore = () => {
          markArranged(false);
          if (!sidebarTaken()) {
            return;
          }
          setSidebarTaken(false);
          const layout = ctx.get("layout");
          if (layout && frameHas("data-sidebar-collapsed")) {
            layout.toggleSidebar();
          }
        };
        /** Fullscreen for the right column, by the person's choice only. */
        const fullscreenFor = (sessionId) => {
          const actions = ctx.sidebarRight?.actions;
          if (sessionId && typeof actions?.setMode === "function") {
            actions.setMode(
              sessionId,
              frameHas("data-rightbar-fullscreen") ? "push" : "fullscreen"
            );
          }
        };

        const openEditor = (url, mode, sessionId) => {
          try {
            if (sessionId) {
              editors.set(new URL(url).origin, sessionId);
            }
          } catch {
            // Not a URL; the tab refuses it below.
          }
          const surface = editorSurfaceUrl(url, mode);
          if (ctx.get("sidebarRightTabs")?.get("browser") !== undefined) {
            ctx.sidebarRight.openTab("browser", { params: { url: surface } });
            return;
          }
          window.open(surface, "_blank", "noopener,noreferrer");
        };

        /**
         * The session an editor at `origin` drives, by the host's own list.
         * The page's map answers first when it has the origin; otherwise the
         * host is asked, so an editor opened before this module reloaded, or
         * from another page, is still recognised. Anything the host does not
         * list is not ours, and is ignored.
         */
        const sessionFor = async (origin) => {
          const known = editors.get(origin);
          if (known) {
            return known;
          }
          // A host that does not answer lists nothing, and nothing is ours.
          const runs = await requestStatus((input, init) =>
            fetch(input, init)
          ).catch(() => []);
          const run = runs.find(
            (r) => typeof r.url === "string" && sameEditorOrigin(r.url, origin)
          );
          return run?.sessionId;
        };

        // What the editor selects lands in the session's composer. The editor
        // posts to its framing window (`attached.ts` in the overlay); the
        // message is trusted only from an editor the host lists, and it is
        // routed to the session that editor drives, not whichever is on
        // screen. The console line per message is deliberate: the desktop
        // app echoes renderer logs to its terminal, which is where a bridge
        // that stays silent gets debugged.
        const log = (text) => console.warn(`[airship] ${text}`);
        ctx.inject?.(["conversation", "sessions"], (bridge) => {
          bridge.effect(() => {
            log("selection bridge listening");
            const onMessage = (event) =>
              receiveSelection(event, {
                composerFor: (sessionId) => {
                  const scope = bridge.sessions.scope?.(sessionId);
                  if (!scope) {
                    log(`sessions.scope(${sessionId}) answered nothing`);
                    return null;
                  }
                  try {
                    return bridge.conversation.input.for(scope);
                  } catch (error) {
                    log(`conversation.input.for failed: ${String(error)}`);
                    return null;
                  }
                },
                log,
                sessionFor,
              }).catch((error) =>
                log(`selection bridge failed: ${String(error)}`)
              );
            window.addEventListener("message", onMessage);
            const unwatch = watchWebviews(onMessage);
            const unwatchClicks = watchChipClicks({ log });
            return () => {
              window.removeEventListener("message", onMessage);
              unwatch();
              unwatchClicks();
            };
          }, "airship.selection.bridge");
        });

        // The page, wherever the composition has a right sidebar to put it in.
        // Registered through `inject` so a profile without the tab kit simply
        // has no page.
        ctx.inject?.(["sidebarRightTabs"], (tabs) => {
          tabs.effect(
            () =>
              tabs.sidebarRightTabs.register({
                guide: [
                  {
                    description: () =>
                      "Point at things on your site and describe the change here",
                    icon: AirshipIcon,
                    id: "open",
                    order: 40,
                    title: () => "Airship",
                  },
                ],
                id: PAGE_ID,
                kind: PAGE_KIND,
                priority: "extension",
                title: () => "Airship",
              }),
            "airship.page.type"
          );
          tabs.effect(
            () =>
              tabs.slots.inject("sidebar.right.pane.tab", () =>
                tabs.slots.register(
                  { key: PAGE_ID, name: "sidebar.right.pane.tab" },
                  (props) =>
                    React.createElement(AirshipPage, {
                      ...props,
                      arrange,
                      fullscreenFor,
                      mark: markArranged,
                      open: openEditor,
                      remember: (url, sessionId) => {
                        try {
                          editors.set(new URL(url).origin, sessionId);
                        } catch {
                          // Not a URL; nothing to remember.
                        }
                      },
                      restore,
                      surfaceUrl: editorSurfaceUrl,
                    })
                )
              ),
            "airship.page.body"
          );
        });
      },
      inject: ["slots", "sidebarRight"],
    };
  },
  id: "@provider-web-artisans/dsh-plugin",
});
