# AGENTS.md

Repository memory for the Data Tracker Firefox extension. See
[DESIGN.md](DESIGN.md) for the full design rationale.

## What this is

A Firefox MV3 extension that logs per-site download sizes locally and shows a
filterable dashboard. No runtime build step and no runtime dependencies.

The listed, signed build is published at
<https://addons.mozilla.org/en-US/firefox/addon/data-tracker/>; the README points
there for permanent installs, and the GitHub release `.xpi` stays unsigned
(temporary installs only). The README's install badge is shields.io's AMO version
badge (`img.shields.io/amo/v/data-tracker`), keyed on the listing slug.

## Commands

```sh
npm test                              # unit tests (Node built-in runner)
npm run lint                          # validate manifest + APIs (0 errors expected)
npm run build                         # write web-ext-artifacts/*.zip
npx --yes web-ext@10 run --source-dir=src   # load in Firefox (requires Firefox installed)
cd src && zip -r ../data-tracker.zip . -x '.*'   # package by hand
```

Node 20+ is needed for tests, linting, and packaging.

## Architecture

- `src/lib/` holds all logic as **pure ES modules with injected dependencies**.
  This is deliberate: it lets the tests exercise the real accounting and storage
  code under Node without a browser. Keep browser globals (`browser.*`,
  `document`, `setTimeout`) out of `src/lib/`; inject them from the entry points.
- `src/background.js` is an **event page** (`background.scripts`), not a service
  worker — Firefox MV3 does not support `background.service_worker`
  (BCD: `service_worker` Firefox support = false). MV3 event pages are
  non-persistent, so all durable state must live in `storage.local`; the
  in-memory buffer in `Collector` is only a write buffer.
- Event-page listeners must be registered **synchronously at the top level**, not
  after an `await`. The page only restarts for events whose listeners existed
  during the synchronous first run; registering `webRequest.onCompleted` after
  `await collector.init()` means those events stop waking the page and the
  requests are silently lost. `bootstrap()` therefore only loads settings; the
  listeners are registered before it runs.
- `onErrorOccurred` is a separate event from `onCompleted`. A request that fails
  or is cancelled mid-flight never fires `onCompleted`, so without this listener
  its (possibly large) transferred bytes vanish entirely. It is counted as a
  request and flagged `errored`, never as known-size. Its `details.error` is
  folded into the `er` reason histogram (always on) and, when the opt-in log is
  on, into a per-request log row.
- `src/lib/requestlog.js` builds the opt-in per-request rows and serializes them
  to CSV. `Collector` keeps a `requestId -> row` index so a precise-mode
  measurement lands on the same row as its request; the index is cleared on every
  flush so it cannot grow unbounded.
- `src/icons/` holds the app and toolbar icons derived from the barbuz brand
  mark (`barbuz.github.io/brand/mark.mjs`), reflected horizontally to read as a
  lowercase `d`, with a geometric `t` in the same stroke style beside it. App
  icons put the accent-blue `dt` on the dashboard table-page grey (`#1c1b22`);
  toolbar icons use the bare `dt` so they read at 16 px. The icon cut omits the
  node device so the two letters stay distinct at small sizes.
- `src/ui/dashboard.*` is the `options_ui` page (opened in a tab). `src/ui/popup.*`
  is the toolbar action. In the site view, a dashboard row expands (click) into
  its per-host breakdown via `hostBreakdown()` — the per-host `h` map is already
  stored, so this needs no extra data, only a second aggregation pass.
- The dashboard hides its two precise-mode columns (`decoded`, `unmeasured`)
  whenever `settings.preciseMode` is off, even if the storage still holds older
  measurements, so the table never implies a measurement the user has stopped
  taking. Both mode checkboxes and their hints live in the `modes` section below
  the table, one hint directly under its own checkbox.
- The results table sits in a `.table-wrap` with `overflow-x: auto`. The table
  has 11 columns and overflows a phone; without the wrapper the whole page
  scrolls sideways. Do not give the table a `min-width` (e.g. `max-content`) to
  "fix" the squeeze — it makes the table overflow its container even on a wide
  desktop window.

## Key facts that shaped the code (verified against MDN/BCD)

- `webRequest` exposes **no byte count**. Sizes come from `Content-Length` via
  `onCompleted` + the `"responseHeaders"` extraInfoSpec. `details.statusCode` and
  `details.method` *are* available on `onCompleted` and are used (via
  `isBodylessStatus()`) to tell a known-empty body from an unknown size; a
  bodyless response's `Content-Length` is ignored.
- `onCompleted` is **informational only** — it does not block, so it is cheap.
  Do not add `"blocking"` here.
- `filterResponseData` requires `webRequestBlocking` + (MV3, FF110+)
  `webRequestFilterResponse` and intercepts every response body. Both are
  declared as `optional_permissions` and requested from the dashboard toggle.
  Firefox grants them **silently** (no prompt) but still requires a user gesture.
- **`StreamFilter.ondata` delivers decoded (decompressed) bytes**, not wire
  bytes: Gecko's `StreamFilterParent::Init` calls `SetNewListener` with
  `aMustApplyContentConversion = true`. So decoded sizes are a different unit
  from `Content-Length` and must never be added to the same column. The
  extension stores both (`d` alongside `b`) and labels them separately.
- A `StreamFilter` must always be `close()`d or `disconnect()`d: leaving one open
  holds the response open indefinitely, i.e. a hung page load. `ondata` chunks
  must be written straight back or the body is truncated. Use `disconnect()` (not
  `close()`) when abandoning a filter mid-stream, so the browser can finish
  delivering the response. All of this lives in `lib/streams.js`.
- `details.documentUrl` is **undefined for top-level documents**; fall back to
  the request URL there.
- Cached responses (`details.fromCache`) transferred no network bytes; never
  added to the wire total `b`. Their count goes to `c` and their size to `cb`,
  always (there is no setting).
- `details.type === "speculative"` requests have unreliable tab info; skipped.
- No `tabs` permission is needed (`webRequest` provides `tabId`).
- `background.type: "module"` requires Firefox 112+, hence a module background.
  `strict_min_version` is set to **140** because `data_collection_permissions`
  (required for new AMO submissions) is only honoured from Firefox 140; older
  Firefox ignores the key, so 112 would work at runtime but trip the linter.

## Storage model

One `storage.local` key per day: `day:YYYY-MM-DD`, plus a `settings` key. A day
bucket is `{ [site]: { b, r, u, c, cb, d, dm, e, x, nb, er, h: { [host]: {b,r,u,c,cb,d,dm,e,x,nb,er} } } }`
where `b`=wire bytes, `r`=requests, `u`=unknown wire size, `c`=cached, `cb`=bytes of
those cached responses, `d`=decoded bytes (precise mode), `dm`=measured
responses, `e`=failed requests (`webRequest.onErrorOccurred`; they may have moved
bytes we can never see), `x`=responses precise mode tried but failed to measure,
`nb`=responses with a known-empty body (1xx/204/205/304, or a HEAD; a real zero,
so excluded from `u`), `er`=failure reason -> count (from `details.error`, so "why
did requests fail" is answerable without the per-request log). `r` is the umbrella
count: every observed request is counted there, and `u`, `c`, `e` and `nb` are
subsets of it. A cached response's bytes always go to `cb`, never `b` — there is
no toggle — so the wire total is always network-only. A bodyless response's
`Content-Length` (a 304's describes the cached copy) is dropped, never added to
`b`. `details.statusCode` is read via
`isBodylessStatus()` in `aggregate.js`; nothing else uses the status. Aggregation
(not per-request rows) bounds growth by days × sites × hosts. Writes are
debounced (3 s) in `Collector` and also flushed on `runtime.onSuspend` and a
periodic alarm.

`cb`/`d`/`dm`/`e`/`x`/`nb`/`er` default to 0/{} in `emptyCounters()`, so day
buckets written by older versions read back without migration.

The **opt-in detailed request log** is a separate key space, `log:YYYY-MM-DD`
(an array of one row per request/error: `{t, site, host, type, sc, b, cb, c, d, e, nb}`),
written by `Store.appendLogs` and capped at `MAX_LOG_ENTRIES_PER_DAY`. `sc` is the
HTTP status, kept so a bodyless 204/304 (empty `b`, `nb=1`) is distinguishable
after the fact from a genuinely unknown size (`b` empty, `nb=0`). It is
gated by `settings.requestLog` (default false) because its size grows with
request volume where the aggregate buckets do not. `Store.listAllDates()` spans
both key spaces so `prune`/`clearAll` remove a day's log and bucket together (a
day can have a log with no bucket, so pruning off `listDates()` alone leaks it).

When changing the storage shape, update `mergeDay`/`accumulate` in
`lib/aggregate.js` and the tests together.

## Conventions

- Keep the dashboard DOM-building free of `innerHTML` (web-ext lints it as
  unsafe); use `textContent` + `createElement`.
- Column-header descriptions and per-row error histograms live in `data-tip`,
  not `title`: native tooltips need hover, which touch screens lack.
  `bindTips()` in `dashboard.js` delegates from the document (so cells created
  on each render need no rebinding) and shows the text on hover, keyboard focus
  and tap in a fixed-position popup on `<body>` (a popup inside `.table-wrap`
  would be clipped by its overflow).
- `manifest.json` must include `browser_specific_settings.gecko.data_collection_permissions`
  (`{ "required": ["none"] }`) — required for new AMO submissions — and the
  `icons` / `action.default_icon` entries under `src/icons/`.
- The AMO add-on ID is `data-usage-tracker@example.local`. It is permanent and
  must not change when the display name or package name changes.
- Unit tests live in `test/*.test.js` and import directly from `src/lib/`.
