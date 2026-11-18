# AGENTS.md

Repository memory for the Data Usage Tracker Firefox extension. See
[DESIGN.md](DESIGN.md) for the full design rationale.

## What this is

A Firefox MV3 extension that logs per-site download sizes locally and shows a
filterable dashboard. No build step, no runtime dependencies.

## Commands

```sh
npm test                              # unit tests (Node built-in runner)
npx web-ext lint --source-dir=src     # validate manifest + APIs (0 errors expected)
npx web-ext run --source-dir=src      # load in Firefox (requires Firefox installed)
cd src && zip -r ../data-usage-tracker.zip . -x '.*'   # package
```

Node 18+ is needed for tests only.

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
- `src/ui/dashboard.*` is the `options_ui` page (opened in a tab). `src/ui/popup.*`
  is the toolbar action.

## Key facts that shaped the code (verified against MDN/BCD)

- `webRequest` exposes **no byte count**. Sizes come from `Content-Length` via
  `onCompleted` + the `"responseHeaders"` extraInfoSpec.
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
bucket is `{ [site]: { b, r, u, c, cb, d, dm, e, x, er, h: { [host]: {b,r,u,c,cb,d,dm,e,x,er} } } }`
where `b`=wire bytes, `r`=requests, `u`=unknown size, `c`=cached, `cb`=bytes of
those cached responses, `d`=decoded bytes (precise mode), `dm`=measured
responses, `e`=failed requests (`webRequest.onErrorOccurred`; they may have moved
bytes we can never see), `x`=responses precise mode tried but failed to measure,
`er`=failure reason -> count (from `details.error`, so "why did requests fail" is
answerable without the per-request log). A cached response's bytes always go to
`cb`, never `b` — there is no toggle — so the wire total is always network-only.
Aggregation (not per-request rows) bounds growth by days × sites × hosts. Writes
are debounced (3 s) in `Collector` and also flushed on `runtime.onSuspend` and a
periodic alarm.

`cb`/`d`/`dm`/`e`/`x`/`er` default to 0/{} in `emptyCounters()`, so day buckets
written by older versions read back without migration.

The **opt-in detailed request log** is a separate key space, `log:YYYY-MM-DD`
(an array of one row per request/error: `{t, site, host, type, b, cb, c, d, e}`),
written by `Store.appendLogs` and capped at `MAX_LOG_ENTRIES_PER_DAY`. It is
gated by `settings.requestLog` (default false) because its size grows with
request volume where the aggregate buckets do not. `Store.listAllDates()` spans
both key spaces so `prune`/`clearAll` remove a day's log and bucket together (a
day can have a log with no bucket, so pruning off `listDates()` alone leaks it).

When changing the storage shape, update `mergeDay`/`accumulate` in
`lib/aggregate.js` and the tests together.

## Conventions

- Keep the dashboard DOM-building free of `innerHTML` (web-ext lints it as
  unsafe); use `textContent` + `createElement`.
- `manifest.json` must include `browser_specific_settings.gecko.data_collection_permissions`
  (`{ "required": ["none"] }`) — required for new AMO submissions.
- Unit tests live in `test/*.test.js` and import directly from `src/lib/`.
