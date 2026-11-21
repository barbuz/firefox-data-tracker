# Data Usage Tracker (Firefox extension)

Logs how much data each site downloads, entirely on your machine, and gives you
a dashboard to review it filtered by date range and site.

- **Lightweight** — no build step, no network calls, no background services. The
  collector uses an informational `webRequest` listener that never slows page
  loads, and writes to disk are debounced.
- **Local-only** — data lives in the extension's own `storage.local`; nothing is
  uploaded anywhere.
- **Reviewable** — filter by date and site, group by site or serving host, and
  export the current view to CSV.
- **Diagnosable** — hover or tap an **Errors** count to see that row's failure
  reasons, and an opt-in **detailed request log** records one line per request
  so the wire and decoded numbers can be compared row by row.

See [DESIGN.md](DESIGN.md) for the full rationale, the accuracy trade-offs, and
the data model.

## Install (temporary)

Use this to develop, or to try the unsigned `.xpi` from the
[latest release][releases].

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select `src/manifest.json`, or the downloaded `.xpi`.

The extension starts collecting immediately. Browse for a bit, then open the
dashboard from the toolbar popup (or `about:addons` → the extension → Options).

> Temporary add-ons are removed when Firefox closes. Permanent installs require
> a signed build; see below.

## Install (permanent)

Firefox release channels only install **signed** add-ons. The `.xpi` attached to
GitHub releases is **unsigned**, so it cannot be installed permanently. To
install permanently, sign the `.xpi` through addons.mozilla.org's unlisted
channel and install the signed copy. A link to the AMO listing will be added
here once it is published.

- **Firefox for Android (release/beta):** after signing, **Settings → About
  Firefox → tap the Firefox logo five times → Settings → Install Extension from
  File**, and pick the signed `.xpi`.
- **Desktop Firefox (release):** after signing, open `about:addons` → the gear
  icon → **Install Add-on from File…** and pick the signed `.xpi`.

An unsigned `.xpi` — whether downloaded from the releases page or built locally
(see [Packaging](#packaging)) — loads only as a temporary add-on, or in Firefox
Developer Edition / Nightly with `xpinstall.signatures.required` set to `false`
in `about:config`.

[releases]: https://github.com/barbuz/firefox-data-tracker/releases/latest

## Use

- **Toolbar popup** — today's total and top sites at a glance.
- **Dashboard** (Options page):
  - **From / To** date pickers, plus Today / 7 days / 30 days / All presets.
  - **Group by** site (the page that caused the traffic, including its third
    parties) or serving host (who actually served the bytes). In the site view,
    click a row to expand it into the per-host breakdown that made up its total.
  - **Site filter** — substring match.
  - **Top N** — limit the table without changing the totals.
  - **Export CSV** — exports all rows matching the current filters.
  - **Why requests failed** — hover or tap an errored count in the table to see
    that row's breakdown by error reason (e.g. `NS_ERROR_NET_TIMEOUT`,
    `NS_ERROR_ABORT`).
  - **Detailed request log** — opt-in; records one line per request and per error
    and adds a **Download detailed log** button (CSV). Off by default.
  - **Settings** — retention window (days, 0 = keep forever), precise mode,
    detailed request log, and **Clear all data**.

## What is measured

For each completed request the extension reads `Content-Length` from the response
headers and attributes it to the page's registrable domain. Details and caveats
(compression, chunked responses with no length, cache, TLS/DNS overhead) are in
[DESIGN.md](DESIGN.md). Responses with no `Content-Length` are counted in a
separate **Unknown wire size** column rather than being treated as zero, so
coverage gaps are visible. Responses with a **known-empty body** — 1xx, 204, 205,
304, or any answer to a HEAD — are the exception: their content really is zero
bytes, so they go in an **Empty body** column and are not counted as a gap (a
304's `Content-Length` describes the cached copy and is never added to the wire
total). Responses served from disk cache moved no network bytes, so their count
goes in a **Cached** column and their size in a separate **Cached bytes** column,
never in the wire total. Requests that fail or are cancelled mid-flight are
counted in an **Errors** column: they never reach `onCompleted`, so their
transferred bytes cannot be attributed, and they are shown rather than silently
dropped. Hovering or tapping an **Errors** count breaks that row's failures down
by reason, so the cause (a timeout, an abort, a dropped connection) is visible,
not just the count.

**Requests** is the umbrella count: every request the extension saw is included,
and **Unknown wire size**, **Empty body**, **Cached** and **Errors** are subsets
of it. Only the wire total and the known-size percentage leave cached requests
out, because they moved no network bytes; unknown-size and failed requests stay
in that percentage as coverage gaps.

### Matching a system data counter (headers and uploads)

If you are comparing against Android's per-app "mobile data usage", two caveats
matter, because those counters and this extension measure different things:

- **Uploads count.** Android reports received *and* transmitted bytes separately
  (`NetworkStats` has `getRxBytes()`/`getTxBytes()`), and its totals are measured
  at the network layer, so they include **both directions** plus packet headers.
  This extension reads only `Content-Length` from *responses*, so it is a
  **download-body** figure: it excludes uploads entirely, and excludes request
  headers, TLS, DNS and QUIC overhead.
- **Header bytes.** Even an empty response moves a few hundred bytes of response
  headers plus TLS records, and every request has a request-line and headers
  going the other way. `webRequest` exposes no packet counts and no header sizes,
  so this extension cannot measure them. As a rule of thumb, add roughly a
  kilobyte per request (more for TLS handshakes) if you need a link-layer figure.

So expect this extension's number to be **lower** than the system counter: it is
response bodies only, not total link usage in both directions.

### Precise mode

An optional **precise mode** toggle measures the bytes each response actually
delivers, using `filterResponseData` and summing `ondata` chunks. It records
those decoded bytes *alongside* the wire bytes rather than replacing them, so the
dashboard shows both columns side by side. This is what makes streamed responses
with no `Content-Length` — server-sent events, `fetch()` streams — visible at all.

Two things to know before enabling it:

- It asks for two extra permissions and makes the extension block on every
  response, so it is heavier than the default observational path.
- Decoded sizes are measured **after** decompression, so they are larger than the
  compressed sizes reported in the wire column. They answer a different question
  ("how much did the page have to process") and are not a data-cap figure.

### Detailed request log

The aggregate view answers "how much did each site use"; it cannot say *which*
request used the bytes or *which* one failed. The optional **Detailed request
log** toggle records one line per request and per error — time, site, serving
host, resource type, wire bytes, decoded bytes, cached flag, and error reason —
so the wire and decoded metrics can be compared request by request and the
failures inspected individually.

It is off by default because, unlike the aggregate buckets, it grows with request
volume. Rows are capped per day, live under the same retention window as the
aggregates, and hold only hostnames, sizes, timestamps, types and error codes —
never the full URL, headers or body. Use **Download detailed log** on the
dashboard to export the current range as CSV.

## Development

Requires Node.js 18+ for the tests only; the extension itself has no runtime
dependencies.

```sh
npm test                 # run unit tests (Node's built-in test runner)
npx web-ext lint --source-dir=src   # validate the extension
npx web-ext run --source-dir=src    # launch Firefox with the extension (if installed)
```

The browser-facing code is thin by design: all accounting and storage logic lives
in `src/lib/` as pure ES modules that take injected dependencies, so the tests
exercise the real code paths without a browser.

### Layout

```
src/
  manifest.json        MV3 manifest (event-page background)
  background.js        wires webRequest events to the Collector
  lib/
    domain.js          hostname parsing + registrable-domain (eTLD+1) reduction
    aggregate.js       byte accounting, day aggregation, formatting, CSV
    store.js           storage.local wrapper: day buckets, log, settings, pruning
    collector.js       request -> bucket folding + debounced flush
    requestlog.js      opt-in per-request log rows + CSV serialization
  ui/
    dashboard.*        options page (filters, table, export, settings)
    popup.*            toolbar popup (today's total + top sites)
test/                  unit tests for lib/
```

## Packaging

An `.xpi` is just a zip of `src/` with `manifest.json` at the top level. Build
one with:

```sh
npm run build      # writes web-ext-artifacts/data_usage_tracker-<version>.zip
```

`web-ext build` names the artifact `.zip`; rename it to `.xpi` for installation
(the format is identical). This build is unsigned: it loads as a temporary
add-on, or on Developer Edition / Nightly with signature checks disabled. Sign
it through addons.mozilla.org for a permanent install. Or zip it by hand:

```sh
cd src && zip -r ../data-usage-tracker.xpi . -x '.*'
```

## Installing on Firefox for Android

The extension targets desktop Firefox, but the APIs it uses (`webRequest`
`onCompleted` with `responseHeaders`, `background.scripts`, `options_ui`,
`storage`) are all supported on Firefox for Android, so it runs there too.

Two ways to install:

- **Temporary (any channel, including release), over USB.** Enable USB
  debugging on the phone and run
  `web-ext run -t firefox-android --adb-device <id> --firefox-apk org.mozilla.firefox`.
  The add-on unloads when Firefox closes.
- **Permanent (requires a signed `.xpi`).** Release Firefox for Android only
  installs signed add-ons. Sign the `.xpi` on addons.mozilla.org (the *unlisted*
  channel is free and signed automatically), then on the phone: **Settings →
  About Firefox → tap the Firefox logo five times → Settings → Install Extension
  from File** and pick the downloaded `.xpi`. The dashboard is available under
  the extension's entry in the Android add-ons list.

## License

MIT — see [LICENSE](LICENSE).
