# Data Usage Tracker — Design

A Firefox extension that records how much data each site downloads, stores the
log locally, and lets you review it filtered by date and by site.

## Goals

- **Lightweight** — no build step, no external services, negligible CPU/memory
  and disk overhead during normal browsing.
- **Local-only** — nothing leaves the browser. No analytics, no network calls.
- **Reviewable** — a dashboard to filter by date range and site, plus a
  per-day, per-site log you can export.

Non-goals: per-request forensic logging, blocking/tracking, cross-device sync.

## How data size is measured

Firefox's `webRequest` API does **not** expose a byte count on any event. There
are two ways to get sizes, with different trade-offs:

| Approach | Accuracy | Cost | Permissions |
| --- | --- | --- | --- |
| `onCompleted` + `responseHeaders` → read `Content-Length` | Good for most responses; **missing** when the server uses `Transfer-Encoding: chunked` and sends no `Content-Length` | Observational, does not block page loads | `webRequest` + host permissions |
| `filterResponseData` → sum `ondata` byte lengths | Exact (counts the bytes actually received, decoded) | Intercepts every response body; runs code per chunk | `webRequest`, `webRequestBlocking`, `webRequestFilterResponse` + host permissions |

We default to the **header approach** because it is genuinely lightweight: the
listener is *informational only* (see MDN: "This event is informational only"),
so it never adds latency to a page load. We record a count of responses with
**unknown size** so the coverage gap is visible instead of silently wrong.

A `preciseMode` setting can later switch to `filterResponseData` for exact
counting at the cost of throughput; it is intentionally off by default.

### What `Content-Length` actually means

`Content-Length` is the size of the response **body on the wire**. When the
response is compressed (`Content-Encoding: gzip/br`), that is the compressed
size — which is exactly what "data downloaded" should mean. It excludes request
headers, TLS overhead, and DNS. Those are documented as out of scope.

### Cached responses

A response served from the disk cache (`details.fromCache === true`) transferred
no bytes over the network. Counting it would inflate totals, so cached responses
are excluded from byte totals by default and tracked in a separate `cached`
counter.

## Attribution: "per site"

A single page load pulls from many hosts (CDN, fonts, analytics). We record two
dimensions for every completed request so the dashboard can group either way:

- **site** — the *document* the request belongs to (`details.documentUrl`, or the
  request URL itself for a top-level document), reduced to its registrable
  domain (eTLD+1). This answers "how much data did this site make me download",
  including its third parties.
- **host** — the server that actually served the bytes (`details.url` hostname).
  This answers "which servers am I downloading from".

The registrable-domain reduction uses a small embedded list of common
multi-label public suffixes (`.co.uk`, `.com.au`, …), not the full Public Suffix
List. This keeps the extension small; a full PSL would be the upgrade path.
Nested iframes are attributed to the iframe's own document, a known
approximation (the true top-level page would require frame-tree tracking).

## Storage model

Data is aggregated, not stored per request. Each calendar day is one
`storage.local` entry keyed `day:YYYY-MM-DD`:

```jsonc
{
  "example.com": {                 // site (registrable domain)
    "b": 10485760,                 // bytes with known size
    "r": 412,                      // completed requests
    "u": 7,                        // requests with unknown size (no Content-Length)
    "c": 33,                       // requests served from cache (excluded from b)
    "h": {                         // per serving-host breakdown
      "cdn.example.com": { "b": 9437184, "r": 300, "u": 2, "c": 10 }
    }
  }
}
```

Why this shape:

- **One key per day** keeps each read/write small and lets a date-range query
  read only the days it needs (`storage.local.get` of a handful of keys) instead
  of the whole dataset.
- **Aggregation** bounds growth by (days × sites × hosts) rather than by request
  volume, so months of browsing stay tiny.
- **Nested host map** gives the second grouping dimension without a second
  top-level key scheme.

### Write path (keeping it cheap)

The background page holds an in-memory `Map<date, dayObject>`. Incoming requests
mutate that map (pure object math, no I/O). A **debounced flush** (3 s) merges the
map into `storage.local`, and `runtime.onSuspend` flushes on shutdown. A periodic
`alarms` tick is a safety net and also drives retention pruning. This means disk
writes are coalesced — a page load with 300 requests produces at most one write.

## Lifecycle (MV3)

Firefox does not support MV3 service workers, so the background is an **event
page** (`background.scripts`, `persistent` defaults to `false` in MV3). Because
the page can be unloaded when idle, all durable state lives in `storage.local`;
the in-memory map is only a write buffer. Listeners are re-registered on each
startup.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` | Observe completed requests |
| `<all_urls>` host permission | Required by `webRequest` to observe requests to a host; measuring all sites inherently needs all hosts |
| `storage` | Persist the local log |
| `unlimitedStorage` | Avoid the storage quota for long histories (still pruned by retention) |
| `alarms` | Periodic flush + retention pruning |

No `tabs` permission is needed: `webRequest` already provides `tabId`, and the
dashboard reads aggregate data from `storage` directly.

## Privacy

- All data stays in the browser profile (`storage.local`).
- No network requests are made by the extension.
- Only hostnames/sizes/timestamps are stored — never full URLs, page content,
  headers, or bodies.
- The user can clear all data and set a retention window from the dashboard.

## Dashboard

`options_ui` page (also opened from the toolbar popup) with:

- Date range (from/to) and quick presets (today / 7d / 30d).
- Group-by toggle: **site** or **serving host**.
- Site filter (substring match + include/exclude the top N).
- Sortable table: bytes (with bar), requests, unknown-size count, cached count.
- Totals, and a **CSV export** of the current filtered view.

The popup shows today's total and the top few sites for at-a-glance use.

## Known limitations

- Responses without `Content-Length` are counted as "unknown", not zero.
- Request headers, TLS, DNS, and QUIC overhead are not counted.
- Registrable-domain reduction is approximate (embedded suffix list).
- Nested-iframe attribution uses the iframe document, not the top page.
- Data is per browser profile; it does not sync.

## Possible extensions

- Exact mode via `filterResponseData` (already scaffolded as a setting).
- Full Public Suffix List for exact eTLD+1.
- Weekly/monthly roll-ups stored alongside daily buckets.
- Per-tab live meter using `webRequest` + `tabs` events.
