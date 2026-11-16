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

See [DESIGN.md](DESIGN.md) for the full rationale, the accuracy trade-offs, and
the data model.

## Install (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select `src/manifest.json`.

The extension starts collecting immediately. Browse for a bit, then open the
dashboard from the toolbar popup (or `about:addons` → the extension → Options).

> Temporary add-ons are removed when Firefox closes. For a permanent install,
> package and sign the extension (see below).

## Use

- **Toolbar popup** — today's total and top sites at a glance.
- **Dashboard** (Options page):
  - **From / To** date pickers, plus Today / 7 days / 30 days / All presets.
  - **Group by** site (the page that caused the traffic, including its third
    parties) or serving host (who actually served the bytes).
  - **Site filter** — substring match.
  - **Top N** — limit the table without changing the totals.
  - **Export CSV** — exports all rows matching the current filters.
  - **Settings** — retention window (days, 0 = keep forever), whether to exclude
    cached responses from byte totals, and **Clear all data**.

## What is measured

For each completed request the extension reads `Content-Length` from the response
headers and attributes it to the page's registrable domain. Details and caveats
(compression, chunked responses with no length, cache, TLS/DNS overhead) are in
[DESIGN.md](DESIGN.md). Responses with no `Content-Length` are counted in a
separate **Unknown size** column rather than being treated as zero, so coverage
gaps are visible.

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
    store.js           storage.local wrapper: day buckets, settings, pruning
    collector.js       request -> bucket folding + debounced flush
  ui/
    dashboard.*        options page (filters, table, export, settings)
    popup.*            toolbar popup (today's total + top sites)
test/                  unit tests for lib/
```

## Packaging

```sh
cd src && zip -r ../data-usage-tracker.zip . -x '.*'
```

Sign with `web-ext sign` (AMO) for a permanent install.

## License

MIT — see [LICENSE](LICENSE).
