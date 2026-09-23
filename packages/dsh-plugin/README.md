# @provider-web-artisans/dsh-plugin

Airship inside the DeepSeek Harness: an **Airship** page in the right sidebar
starts the visual editor on your dev server with one button, `airship_open`
does the same when the model decides to, and a sidebar **Browser** tab shows it.
Either way the editor is attached to the session on screen: its prompt drives
that conversation, not one of its own.

Two files and a patch — no build, and no imports from the harness:

```
index.js          the host half: three tools, the `/airship/*` routes behind the page, and the processes they supervise
client.js         the client half: the Airship page, and the bridge that puts what the editor selects into the session's composer
cordis.patch.yml  the bundle layer that mounts the host half
```

## Install

```sh
dsh plugin --profile <profile> add /path/to/packages/dsh-plugin
```

The bundle's patch mounts the host half; the `dsh.client` manifest in
`package.json` is what the loader reads to put the client half in the session's
module graph. Nothing else is needed — no PATH entry, no config.

### A profile the desktop app owns

The `desktop` profile cannot be installed, or even booted, from a terminal — the
CLI refuses it outright:

```
$ dsh plugin --profile desktop add /path/to/packages/dsh-plugin
error: profile "desktop" is managed exclusively by the Electron application
```

That is not a permission to work around: the app carries its own Node and pnpm,
and that profile is composed under them. Install it from inside the app instead —
**Plugins → + Add plugin**, with the package's absolute path — and restart, since
a bundle is read at boot. A local path is one of the specs that dialog accepts,
alongside a package name, a Git address and a tarball.

## Use

### From the sidebar

Open the right sidebar's guide and pick **Airship** (its own mark, beside
Browser). The page is drawn with the harness's own primitives, on the grid
of its own flow rows, one line per thing: the project's name and path; the
site — whether it is running, from `GET /airship/inspect`, which runs
`airship inspect --json` in the session's directory, the same detection
`serve` uses when `--target` is omitted — with its controls at the right;
then one line per editor. Controls are the harness's round icon buttons
with hover labels, except the one that matters: **Open Airship**, a labelled
button on the site's line until this session has an editor.

The site's line offers **Stop the site** (while it answers) and **Check
again**. Stop is for a dev server that hung: `POST /airship/stop` with the
port ends the editor on it, if any, and then whatever still listens there
and works inside the session's project — a server the person started
themselves included. A listener working elsewhere is not the project's and
is left alone, with a `409` that says so. The page then looks the project
up again, so Open starts the site afresh.

This session's editor is one line — where it shows, on which port — with
**Show the editor**, **Fullscreen** and **Close the editor**. An editor
another session holds is one line too, with **Use in this session** and
**Close that editor**. The port, the start command and the surface (on the
page, or on a canvas) sit under **Options**, closed by default and
prefilled from the look-up: the port the host would pick, and the start
command only when nothing is listening. A port typed once is remembered per
project.

The button posts to the host's `POST /airship/open`, which starts the editor
attached to the session you are looking at and answers with its URL; the page
then puts it in a Browser tab. A body without a port gets the same detection:
a dev server that answers wins, otherwise the project's own dev script is
started, and a project with neither is refused with a reason.

No model is involved. That is the point: a tool call is only as reliable as the
model's decision to make it, and the row it leaves behind folds away with the
turn in the chat's compact display — the page stays where you left it.

The route takes the same care as every other host route: the connection
service vouches for the caller, the body is a small JSON object with `port`,
`sessionId` and optional `command` and `mode`, and the project directory is
the named session's own, read from the session store rather than trusted from
the wire — a session the host does not have open, or one without an absolute
directory, is refused before anything starts. The directory and the `dsh`
backend are pinned on the CLI's command line, so a project's
`airship.config.json` cannot move the editor elsewhere or hand it to another
backend; an `exec` in that file still applies when the page names no start
command.

One editor per port, and that editor drives one session in one project. Asking
for a port that already serves another session, or another directory, is
answered with `409` rather than with someone else's editor. The page lists
every running editor (`GET /airship/status`): **Use in this session** is the
same open with `takeover: true`, which stops that editor and starts it again
attached to this session, and either **Close** is `POST /airship/close` with
the port, which also stops a dev server the editor started.

### One conversation

While the window is arranged for an editor the chat column is narrow, so
the conversation header — the title, the mode and team actions, Open in
app, the export menu — fades out under a stylesheet the plugin installs;
only the corner with the layout controls stays. The rule keys on the
frame's own `data-rightbar-collapsed` and the corner's
`data-conversation-header-corner` attributes rather than hashed classes,
and applies only while the right column is open: close it, by any means,
and the header fades back in; open it again and it fades out again. The
arranged mark itself follows the host's list of editors, not the page's
memory of opening one, so an editor closed elsewhere lifts it too.

Attached, the editor keeps no chat of its own: its left dock is gone, its
design panel opens only from its pill rather than on every click, and the
person writes in the session's chat. With the **Inspect** tool, a click
on an element puts a chip in the composer — Airship's mark, then
`<button.btn> Hero.astro:42` — the same atomic reference an `@file` mention
is: several can be collected, each is deleted on its own, and none is part
of the typed text. The same element twice is one chip. A composer that
takes no chips gets one text line at the top instead. Move selects for
dragging and editing without telling the chat.

The chips have an owner: the client half registers an `@` trigger source
named `airship` (it lists nothing in the `@` menu — the editor is where
selections are made). The composer expands every chip through its owner's
codec when the draft is sent, and refuses a draft whose chips have none, so
the source is what makes a chip sendable. Its codec writes `@src/Hero.astro
(Airship selection: <button.btn> (Button) at src/Hero.astro:42 — “Get
started”)`, the `@file` mention in front so the harness's file reference
has the model read the file. The chip's own reference is JSON: the editor
it came from, the selection's id and its place in the document, and the
element. Clicking a chip hands that to the source's `openReference`, which
asks the editor for the element back: a `<webview>` runs a `postMessage`
from inside, a frame is posted to, and the overlay selects the element
again — by id while the page lives, by path after a reload — without
announcing it a second time. The chip host carries the source's name
(`data-composer-chip="airship"`), which is how the plugin's stylesheet
dresses ours as a pill with Airship's mark in place of the file glyph, and
an × at its right. The × removes the chip: the composer has no verb for
that, but its editor takes a `beforeinput` of `deleteContentBackward` at
the caret, reading the caret from the document for that event, so a
capturing click listener puts the caret right after the chip and
dispatches that one event on the editor's root — the same deletion
Backspace makes, whole. The composer's own click, which would take the
click for the reveal, never sees it.

The selection reaches the client half two ways, because hosts differ: the
editor posts a message to every window framing it (the web app's Browser
tab is an iframe), and writes one `[airship:selected]` line on its console
(the desktop app's Browser tab is an Electron `<webview>`, whose embedder
hears the guest's console). Either way it is acted on only when the sender
is an editor the host lists, and it goes into the session that editor
drives — not whichever session is on screen. Every accepted or ignored
message logs one `[airship]` line, which the desktop app echoes to its
terminal.

### By asking

> Start my dev server and open Airship on it.

The agent calls `airship_open`, which:

1. runs `airship --target <port> --json` — `port` is optional, and when it is
   left out the same detection as the page decides it (adding `--exec
   "<command>"` when the tool was given one or the project's dev script has to
   be started, so Airship starts the dev server and stops it again when the
   editor closes);
2. waits for the banner and returns the editor URL;
3. answers with the editor URL, which the chat renders as a link into the
   sidebar's Browser tab (`mode`, `inline` by default or `canvas`, is a tool
   argument too).

`airship_status` lists what is running; `airship_close` stops one editor or all
of them. Closing the plugin stops every child it started.

The editor is pointed back at the session that opened it — `--dsh-url` for the
host and `--dsh-session` for the calling agent — so its own panel drives *this*
conversation instead of spawning a child session beside it, and the harness keeps
governing the turn: its permission preset decides what may run, and its window is
where a person answers. A caller that names another `agent`, or a host that
serves no web UI, gets Airship's own backend instead.

Set `AIRSHIP_BIN` when `airship` is not on the harness host's `PATH` — a harness
launched from Finder or the desktop app does not inherit a shell's `PATH`.

## What it deliberately does not do

- **It does not open the tab by itself.** Every shipped call site for that tab is
  a click, because a tab that opens itself takes the right-hand column away from
  whatever the person was reading. The tool's text carries the bare URL, so
  the markdown link handler offers the trip.
- **It does not bundle Airship.** The CLI is the contract, so the plugin can
  serve an editor it did not install.
