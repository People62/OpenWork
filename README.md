# Rantai

A desktop application that takes OpenWork's approach and replaces its client
side: **a Rust local backend inside Tauri, a Next.js interface, bun as tooling**.
Den (the central server) and OpenCode (the agent engine) are kept as they are.

Where it stands: **Phase 5 — the conversation is wired to the engine**. Tokens
stream onto the screen, a turn can be stopped mid-flight, and the history comes
back from OpenCode's own store rather than a copy of our own.

## Language

Everything — code, comments, doc-comments, commit messages, branch names, pull
requests and this document — is in English. Rust doc-comments are carried into
the generated `bindings.ts`, so a mixed language inside the code leaks into
generated files.

One deliberate exception: the first migration in `src/db.rs` keeps its
Indonesian table and column names, because it has already run against databases
in the wild. The second migration is what renames them. A migration edited after
it has run somewhere is no longer a migration.

## Who stores a conversation

OpenCode does. Rantai keeps no session or message table.

This was measured, not assumed. OpenCode's own SQLite already holds every
session and message with the title, the model, the cost, the token counts, the
reasoning and the tool calls — and that copy is the one the engine reads as
context for the next turn. A second copy on our side would be the one on screen
while the model answered from the other, and nothing would say which was right.

The reference implementation reached the same conclusion first: its
`runtime.sqlite` holds only per-workspace config blobs, and its session routes
are a proxy.

What is still ours is the **workspace** — a folder someone chose, under a name
they chose. OpenCode derives its own `project` from the path alone and has no
room for that name.

### One engine, two APIs

OpenCode v1.18.18 carries two generations of its HTTP API side by side: a newer
one under `/api/…` and an older one at the root. They share one table of
sessions but **keep their messages apart** — a turn sent through one is
invisible to the other. Measured across nineteen sessions: every one had its
messages in exactly one of the two lists, never both.

Conversations go through the older generation, because the newer one does not
run a turn from OpenCode's own credential store:

| Engine started with the key… | A turn through `/api/session/{id}/prompt` | Through `/session/{id}/prompt_async` |
| --- | --- | --- |
| only in `auth.json` | accepted, then **never runs** — no answer, no error | runs |
| in `auth.json` and in the environment | runs | runs |

`auth.json` is where `opencode auth login` and the AI Providers screen both put
a key, and it is all an installed application has. Every test in this
repository passed for a long time because the engine happened to inherit the
key from the developer's environment; the live tests now strip every
`*_API_KEY` before starting it.

| Purpose | Route |
| --- | --- |
| send a turn | `POST /session/{id}/prompt_async` — `{parts, model}` |
| stream it | `GET /event` |
| read a conversation | `GET /session/{id}/message` — oldest first |
| stop a turn | `POST /session/{id}/abort` |
| models that can run | `GET /provider` — `connected`, and each provider's `models` |
| list or create sessions | `/api/session` — shared, so either generation works |

### Reading history is free of the working directory

`GET /api/session?directory=…` lists any folder's sessions from one engine, so
the sidebar never waits on a restart. Creating a session is bound to the engine's
own working directory — a create aimed at another folder came back located in
the engine's — so choosing a workspace to *work in* restarts the engine there.

## Design system

Colour tokens, typography and 42 interface components were carried over from
OpenWork. `colors.css` and `tailwind-theme.css` are copied without a single
change — they are the token layer, and editing them here would mean two
definitions of the same palette.

Not one of those 42 components touches `fetch`, `/api/`, or `invokeDesktop`.
That is why the look could move first, long before the Rust backend had grown
enough for the screens that use it.

### Checking the look

```bash
bun run audit    # WCAG AA contrast, every route, both themes
bun run shot     # screenshots into .shots/
```

A change to the look is the one kind of change a test suite cannot check. The
audit runs against the export in headless Chrome — Tauri uses the system webview
and none of the three speak CDP, but what is measured is the stylesheet, and
that is the same either way.

It found two real violations the day it was installed: muted text on a selected
row came out at 4.29:1, short of the 4.5:1 AA demands. The token was right and
the surface under it was wrong — `--dls-active` is `tinted-5`, a step meant to
sit behind components, not behind step-11 text. A selected row is now marked
with a rule on its left edge rather than a darker background.

Both scripts find sidebar rows by `data-row` and messages by
`data-message-role`, not by DOM shape. The first version walked
`aside ul li button`, and the day the sidebar stopped being a list of lists it
would have silently measured the empty state instead.

## Layout

```
apps/ui                    Next.js, App Router, output: 'export'
  app/bindings.ts          Generated from Rust — never edited by hand
  app/shell/               The three-column frame, its lanes and its panes
  app/session/             Composer, conversation, empty state
  app/workspace/           Workspaces, and what the screen knows
  app/den/                 Den sign-in: the link parser and its screen
apps/desktop/src-tauri     The Rust program — Tauri shell and local backend both
  src/domain.rs            The workspace, and nothing else
  src/db.rs                The SQLite connection and its migrations
  src/commands.rs          The boundary to the interface — #[tauri::command]
  src/error.rs             One error type for the whole boundary
  src/engine/locate.rs     Finds the OpenCode binary, and names everywhere it looked
  src/engine/mod.rs        Starts, watches and stops the engine process
  src/engine/client.rs     The part of the SDK we use, rewritten against its HTTP API
  src/conversation.rs      Sessions, messages, streaming tokens and stopping them
  src/deeplink.rs          The openwork:// deep link and opening the system browser
  src/smoke.rs             The check mode CI runs
.github/workflows          The three-platform matrix
```

Tauri *is* a Rust program. The local backend is not attached to Tauri from
outside; it is written inside it as `#[tauri::command]` and called from the
interface through `invoke()`. There is no loopback HTTP, no dynamic port, no
CORS and no token between the two.

## Running it while developing

There are two ways, and which one is right depends on what you are changing.

### The look only — in a browser, reloading instantly

```bash
cd apps/ui
bun run dev:mock          # http://localhost:3000
```

This runs the interface without Tauri and without Rust, with mock data so the
screens actually render. Changes to components, styles and layout show up at
once without rebuilding anything.

It suits a headless development machine edited over VS Code Remote: VS Code
forwards port 3000 itself, so the page opens in a browser on your own machine.

The mock switches on **only** when all three of these hold: running in a
browser, no real Tauri, and `NEXT_PUBLIC_RANTAI_MOCK=1`. The flag is required
rather than inferred from `NODE_ENV` — a mock that decides for itself when to
switch on is a mock that will one day switch on in somebody's installed
application. It also writes a warning to the console every time it is active.

It stands in for the event channel too, so a live conversation can be watched in
a browser: tokens arrive as Tauri events, and a `send_prompt` that answers
nothing would leave the composer spinning forever.

Its fixtures, `apps/ui/app/dev-fixtures.json`, are shared with the contrast
audit. Two sets of pretend data drift apart, and then the thing being audited is
not the thing being looked at.

**Its limits:** no OpenCode engine, no SQLite, no deep links. A button that calls
a Rust command answers from mock data, not from anything real.

**If the page arrives with no styling at all**, delete `apps/ui/.next` and start
again. A corrupt Next cache serves the raw Tailwind source — `@apply` and
`@theme` unprocessed — and nothing in the logs says so. It is not the PostCSS
config, and it is not a missing package.

### The whole application — a real Tauri window

```bash
bun run dev               # from the repository root
```

This builds Rust, starts `next dev` and opens a Tauri window. **It needs a
display** — on a headless machine the window will not be visible.

On a machine with a display, prepare the engine too:

```bash
export RANTAI_OPENCODE=/path/to/opencode   # or run `bun run sidecar`
```

Changes to TypeScript files still reload instantly. Changes to Rust require the
window to be closed and `bun run dev` run again.

## Commands

```bash
bun install
bun run dev              # Tauri window + next dev
bun run build            # next build --export, then the installers
bun run typecheck        # interface types
bun run rust:lint        # clippy, warnings treated as errors
bun run rust:test        # Rust tests; this is also what writes bindings.ts
bun run test             # interface tests
```

## Types are generated, never written twice

`apps/ui/app/bindings.ts` is generated from the command list in Rust by
`cargo test`, through `tauri-specta`. It is never edited by hand, and CI demands
a clean `git diff` over it.

The consequence is that changing the shape of data in Rust raises a type error
in Next.js — that is the Phase 1 gate, and it was tested by actually renaming a
field: `tulis_baca_utuh` to `tulis_baca_benar` made `tsc` refuse in two places,
naming the line and the property.

A command that returns `Result` in Rust does not throw in TypeScript; it returns
`{ status: "ok" | "error" }`, so code that ignores the error branch does not pass
the typecheck. The `unwrap()` wrapper in `app/tauri.ts` turns it into a `throw`
for callers who prefer `try/catch`, without losing the error's type.

A type that derives both `Serialize` and `Deserialize` in Rust arrives as two in
TypeScript — a field with `#[serde(default)]` is optional coming in and present
going out. Commands hand over the outgoing half, and `app/tauri.ts` names it
there so the generated name does not spread through the interface.

On Linux this needs `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`,
`libsoup-3.0-dev`, `librsvg2-dev` and `patchelf`. On a headless machine, run it
through `xvfb-run -a`.

## Smoke mode

The application can be run as a check that ends itself. It waits for signals
that come in order — the later ones cannot arrive if the earlier ones did not:

| Signal | What its arrival means |
|---|---|
| `webview-loaded` | The page loaded, the bundle ran, React mounted |
| `ipc-roundtrip` | An answer from Rust reached the screen, then went back to Rust |
| `data-roundtrip` | SQLite was written and read back intact |
| `engine-absent-correct` | A missing engine binary produced the right message |
| `deep-link-received` | `openwork://den-auth` reached the screen with the right grant |
| `data-persisted` | A workspace was written, the application closed, then read back intact |

```bash
RANTAI_SMOKE=1 \
RANTAI_SMOKE_REPORT=/tmp/rantai-smoke.json \
xvfb-run -a apps/desktop/src-tauri/target/release/rantai
```

All of them arrive: exit 0. Past the deadline (`RANTAI_SMOKE_TIMEOUT_MS`,
default 120000): exit 1, and the report names which signal never came.

**Use the binary `tauri build` produces, not `cargo build`.** What decides this
is not the debug or release profile but who runs the build: a plain
`cargo build --release` still produces a dev context, and the application will
load `devUrl` instead of the embedded export.

This has misled twice here. Smoke mode failed with zero signals and looked like
total silence — while the application was alive and waiting for a `next dev`
server that was not there. The page-load trace smoke mode prints exists for
exactly that: it names the address being loaded, so `http://localhost:3000`
separates "wrong build" from "genuinely broken" at a glance. The right one reads
`tauri://localhost`.

## The OpenCode engine

The binary is downloaded by `apps/desktop/scripts/prepare-sidecar.mjs` and
**verified against a pinned sha256** in `apps/desktop/opencode.json`. A mismatch
stops the build.

```bash
bun run sidecar     # download, verify, place it in src-tauri/binaries/
```

The reference implementation computes the hash and logs it afterwards, but never
compares it against a known value — so a 176 MB download was verified against
nothing but the URL it came from. That hole is closed here.

### The engine ships as a resource, not as externalBin

This was decided by trying both. As an `externalBin` it lands in `usr/bin` beside
the application — and `linuxdeploy`, while building the AppImage, runs `patchelf`
over every ELF it finds there. That **corrupts** OpenCode: the copy inside the
AppDir core-dumped, and linuxdeploy stopped with "Failed to run ldd".

As a resource it lands in the resource directory, which is not treated that way,
and its executable bit survives. Measured on the `.deb`: the copy is
byte-identical to the original and answers `--version` correctly.

### Models must be asked for, never guessed

Provider availability in OpenCode **depends on the engine's working directory**.
The same folder can offer dozens of models or none, depending on whether OpenCode
recognises it as a project. Measured on the development machine: this repository's
root offers 31 models, `~` offers none.

Every prompt names its model, and a conversation can change model between
turns — measured by switching models between two turns of one session, each
answered by the model it named. Without a model the engine falls back to its
own default; on the development machine that is OpenCode's free tier, which
refuses to answer outside the OpenCode application.

The newer `/api/model` does not list a provider whose key is only in
`auth.json` — with the key only there it offered 31 models, all of them the
free tier. `/provider` lists what is actually connected, and each provider's
default model is put first. The free tier's own provider, `opencode`, goes last.

### Tokens flow from `/event`

For a turn sent through `prompt_async`, tokens arrive on `/event` as
`message.part.delta`; `/api/event` carried six events for the same turn and not
one token. A turn ends with `session.idle` — after every step, tool calls
included, and after a turn that was stopped.

A delta does not say what kind of part it belongs to: its `field` is `"text"` for
reasoning as much as for the answer. The kind of each part comes from
`message.part.updated`, which the engine sends before that part's first delta,
and only `text` parts stream onto the screen.

The prompt is sent only once the stream is open. A short turn can finish before
a stream opened after it has connected, and then its end is never seen.

This stream also **sends no `event:` lines at all** — only `data:`, with the event
kind inside the JSON as a `type` field.

### Message parts

An assistant message is a list of typed parts: `text`, `reasoning`, `tool`,
`step-start`, `step-finish`. A user message is not — it carries flat `text`.

The `Part` enum has a catch-all variant, and that variant is load-bearing:
without it, the first part kind we have not met would fail to parse the whole
conversation rather than itself.

### Finding the binary

The binary is not in the repository — 176 MB, downloaded separately. To run it
from here, just point at it:

```bash
export RANTAI_OPENCODE=/path/to/opencode
bun run dev
```

The search order is: the `RANTAI_OPENCODE` override, then the sidecar beside the
application, then `PATH`. **PATH is deliberately last**, so an OpenCode that
happens to be installed on a developer's machine can never quietly mask a sidecar
that did not make it into the package — that mistake wasted three reproduction
attempts in the reference.

If the binary is not found, the message names **every place that was checked**.
That is not a luxury: in the reference, a missing engine binary produced a message
naming "SIGKILL" — the cleanup symptom, not the cause — and three CI rounds went
chasing the wrong thing. A test specifically demands that the message does **not**
name a signal or an exit code.

### No orphan processes

`kill_on_drop` alone is not enough: it only applies on the normal drop path, and
`std::process::exit` runs no destructors. The engine is therefore stopped at the
two exits that are certainly taken — Tauri's `RunEvent::Exit`, and smoke mode's
watcher. This was found by listing processes after a run, not by reading code:
the first version left OpenCode alive to be reaped by `init`.

Switching workspaces replaces the process, and the check and the spawn happen
under one lock. Releasing it between them would let two workspace switches land
at once and leave a process with no handle to it — which is how an orphan engine
happened before.

## The shape of CI

One merged change triggers **two** three-platform rounds, not three:

| When | What |
|---|---|
| Pull request | the three-platform matrix + typecheck, clippy, tests |
| Merge to main | the release workflow: build, run, publish the installers |

The matrix no longer runs after a merge. Branch protection demands a green PR
*and* one that is up to date with main, so the merge result is a commit that has
already been tested — running it again tells nobody anything.

Each platform job launches the application **three times**, not seven. Every
launch emits the three core signals, so a launch that only checks those is pure
repetition. And expectations stack: one process can be asked to prove the engine
starts from the bundle, the deep link arrives and data was written, all at once.
Only two things genuinely need a process of their own: reading data back after
the first one died, and running without the engine.

## Saved and reopenable

Release 1 promises that work is "saved and can be reopened". That is only proved
by running the application **twice**: once to write, once to read after the
process has really died. A test inside one process can pass entirely from an
in-memory cache without a single byte touching disk.

CI does exactly that on all three platforms, and a marker that is never written
has been proved to genuinely fail it.

What that check covers is the **workspace**. Conversations are OpenCode's to
keep, and proving those survive would mean a running engine in both processes —
which the sibling check deliberately denies, since it exists to prove the
application survives the engine being missing. The check claims exactly what it
tests, and no more.

## Den sign-in

Of the whole sign-in, only two things are native: receiving `openwork://den-auth`
from the system, and opening the system browser. The rest is TypeScript that
moves across unchanged.

Those two were done earliest in Phase 3 on purpose. URL scheme registration
behaves differently on every operating system, is at its most fragile in
development mode, and **in the reference it was never covered by a CI test at
all**.

Now it is. CI launches the application with `openwork://den-auth?grant=…` and
demands the right grant reaches the screen. A link that does not arrive, or
arrives with a different grant, fails CI — both have been proved to fail, not
merely assumed to.

On Linux and Windows the system hands the link over as a command-line argument.
macOS uses Apple Events, so there it runs as a non-blocking probe until that path
is understood.

### The launch link is read, not drained

The link that *launches* the application arrives long before the page loads — and
that is by far the commonest case: someone clicks a link while the application is
not running. It is therefore recorded as a fact that can be read repeatedly, not
as a queue that is drained. The first version lost it entirely; the second
drained it and two readers raced. Both were caught by running, not by reading.

### The scheme is registered at startup

The application registers `openwork://` when it starts, and only if it is not
registered already. Installers handle this on Windows and macOS; Linux needs it
at runtime, and development builds need it everywhere because nothing installed
them.

Failing is not fatal — that is precisely why the manual paste path exists.

On a minimal development VM the registration **partly fails**: the `.desktop`
file is written correctly, but `update-desktop-database` is not installed so the
MIME database is never refreshed. The original error read only "No such file or
directory (os error 2)" — naming neither the file nor the fix. The message now
adds both.

### The fallback

There is always a manual paste box beside it: the whole link, or just the code.
Pure TypeScript, zero native, and therefore the one part of the sign-in that is
certain to work wherever deep links do not.

## Automatic updates

The updater has its own signing key, generated locally with
`tauri signer generate`. It is **not** an operating-system signing certificate —
the two are different things. This key proves an update came from this
repository, and it is free. OS signing is what quiets SmartScreen and Gatekeeper,
and this project deliberately runs without it.

The private key lives in this repository's GitHub Secrets. **If it is lost, no
update can ever reach an already-installed application anywhere.**

### Updates are driven by tags, not by rolling builds

`main-terbaru` always carries the version written in `tauri.conf.json`, and the
updater only offers a version *higher* than the installed one. A manifest from a
rolling build can therefore never trigger an update — it would only be fetched
and rejected, every time.

To ship an update: raise the version in `tauri.conf.json`, then push a `v*` tag.

### The check is never automatic

The interface asks, and the interface decides. An update that installs itself
while someone is in the middle of a conversation with the engine is a worse
outcome than one that waits. The engine is stopped before the application's files
are replaced — on Windows a live child process can hold a file open and make the
replacement fail outright.

## What comes next

| Phase | Contents | Gate |
|---|---|---|
| **0** ✅ | The skeleton, one command, three-platform CI | The installer builds and the window opens in CI |
| **1** ✅ | SQLite and migrations; the domain model; TS types *generated* from Rust | Changing the shape of data in Rust raises a type error in Next.js |
| **2** ✅ | Starting, watching and stopping OpenCode from Rust; streaming tokens | A whole conversation can be stopped without an orphan process — including when the engine binary is deliberately removed |
| **3** ✅ | The interface moved across; Den sign-in tested first | Used for real work for a week |
| **4** ✅ | Updater, menu, tray, deep links | An installer installs, then receives an automatic update |
| **5** ◐ | The conversation wired to the engine; OpenCode config; workspace files | Ask something, get an answer, reopen the application, the answer is still there |

The full plan, with its numbers and risks, is in `CLAUDE.md`.
