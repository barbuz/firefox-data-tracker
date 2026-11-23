# Data Tracker — Design

A Firefox extension that records how much data each site downloads, stores the
log locally, and lets you review it filtered by date and by site.

## Goals

- **Lightweight** — no build step, no external services, negligible CPU/memory
  and disk overhead during normal browsing.
- **Local-only** — nothing leaves the browser. No analytics, no network calls.
- **Reviewable** — a dashboard to filter by date range and site, plus a
  per-day, per-site log you can export.

Non-goals: blocking/tracking, cross-device sync, and *always-on* per-request
logging. A detailed per-request log is available, but it is opt-in (see below),
because unlike the aggregate buckets it grows with request volume.

## How data size is measured

Firefox's `webRequest` API does **not** expose a byte count on any event. There
are two ways to get sizes, with different trade-offs:

| Approach | Accuracy | Cost | Permissions |
| --- | --- | --- | --- |
| `onCompleted` + `responseHeaders` → read `Content-Length` | Good for most responses; **missing** when the server uses `Transfer-Encoding: chunked` and sends no `Content-Length` | Observational, does not block page loads | `webRequest` + host permissions |
| `filterResponseData` → sum `ondata` byte lengths | Counts the bytes each response actually delivers, **after** content conversion (decompressed) | Intercepts every response body; runs code per chunk | `webRequest`, `webRequestBlocking`, `webRequestFilterResponse` + host permissions |

We default to the **header approach** because it is genuinely lightweight: the
listener is *informational only* (see MDN: "This event is informational only"),
so it never adds latency to a page load. We record a count of responses with
**unknown wire size** so the coverage gap is visible instead of silently wrong.

### Failed and cancelled requests

`onCompleted` only fires for requests that finished. A request that fails or is
cancelled part-way — a large download the user stopped, a dropped connection —
never reaches it, so without extra handling its transferred bytes would be
invisible entirely. `webRequest.onErrorOccurred` fires in that case, and the
extension counts the request and flags it `errored` (`e`). It has no known size,
so it is never added to the wire bytes and it counts against known-size
coverage: it is a *known blind spot*, recorded rather than silently dropped.

`onErrorOccurred` also carries `details.error` (e.g. `NS_ERROR_NET_TIMEOUT`,
`NS_ERROR_ABORT`, `NS_BINDING_ABORTED`). Each failure folds that reason into a
per-day histogram (`er`), so the dashboard can answer *why* requests failed, not
just how many. The histogram is bounded by the number of distinct error codes,
so it is always on — unlike the per-request log below.

### Detailed request log (opt-in)

The aggregate buckets are deliberately one row per (day, site, host): they can
say how much a site used and how many requests failed, but not *which* request
used the bytes or *which* one failed and why. Answering "compare the wire and
decoded numbers request by request, and see the main reasons for errors" needs a
finer record, so the extension offers an opt-in **detailed request log**.

When enabled (`settings.requestLog`), the collector writes one row per request
and one per error, under `log:YYYY-MM-DD`:

```jsonc
{ "t": 1700000000000,      // request timestamp (epoch ms)
  "site": "example.com",   // owning document (registrable domain)
  "host": "cdn.example.com", // serving host
  "type": "script",        // webRequest resource type
  "sc": 200,               // HTTP status, null when unavailable
  "b": 2048,               // wire bytes (Content-Length), null when unknown
  "cb": null,              // cached bytes, null unless served from disk cache
  "c": 0,                  // 1 when served from disk cache
  "d": null,               // decoded bytes (precise mode), filled in later
  "nb": 0,                 // 1 when the response had no body (204/304/…)
  "e": "" }                // error reason for a failed request, else ""
```

The status code (`sc`) is what makes the size columns interpretable after the
fact: a `204`/`304` with an empty `b` is a *known* zero, whereas an empty `b` on
a `200` is a genuine unknown. A bodyless response sets `nb` so the two cases are
never confused.

A precise-mode measurement for a request is folded back onto that request's row
(by `requestId`), so a chunked/streamed response shows its decoded total on the
same line that shows it had no wire size — that is what makes the two units
comparable row by row. A failed request carries its reason in `e` and no size.
As in the day buckets, a cached response's size goes in `cb` (never `b`), so
summing the log's wire column matches the dashboard's network-only total.

It is **off by default** because, unlike the aggregate buckets, its size grows
with request volume. Two guards keep that bounded: rows are capped per day
(`MAX_LOG_ENTRIES_PER_DAY`) at the store boundary, and they live under the same
retention window and "Clear all data" as the buckets. The log holds only
hostnames, sizes, timestamps, types and error codes — never the full URL,
headers or body — so the privacy rule is unchanged. It can be exported as CSV
from the dashboard (one row per request, wire/cached/decoded byte columns and
the error).

### Precise mode, and why both numbers are stored

The two approaches measure **different quantities**: `Content-Length` is the
compressed size on the wire, while `filterResponseData` sees the body *after*
decompression (`StreamFilterParent::Init` calls `SetNewListener` with
`aMustApplyContentConversion = true`). Decoded sizes are typically several times
larger than wire sizes for text, so the two are not interchangeable and mixing
them in one column would be misleading.

Rather than replace one with the other, the optional **precise mode** records
both at once:

- `b` — wire bytes, from `Content-Length`, as before.
- `d` — decoded bytes, summed from `ondata` chunks.
- `dm` — how many responses contributed a `d` measurement.

The dashboard shows the decoded column alongside the wire column only when
precise mode has recorded something, so the two units are never conflated.

Precise mode is off by default for two reasons. It requires the optional
`webRequestBlocking` + `webRequestFilterResponse` permissions (requested from
the dashboard toggle, since Firefox needs a user gesture), and it moves the
extension into the *blocking* path of every response, which the default
observational design deliberately avoids.

### What precise mode buys: streamed and chunked responses

A chunked response has no `Content-Length`, so the header approach records it as
`unknown` and its bytes are missing from the totals. `ondata` fires per chunk as
bytes arrive and `onstop` fires at the end, so precise mode can measure
responses that the header approach cannot see at all — server-sent events
(SSE), `fetch()` streams, and other long-lived HTTP bodies.

The stream filter must obey two rules, both enforced in `src/lib/streams.js`:

1. Every chunk handed to `ondata` is written straight back, or the response is
   truncated.
2. Every filter is always closed or disconnected. A filter left open holds the
   response open indefinitely, so a leaked filter is a hung page load. Open
   filters are also capped, and all are released on event-page suspend.

Precise mode can also *fail* to measure a response: the filter could not be
created (the API threw, or the request was already gone), the cap evicted it
before any bytes arrived, or it was disconnected with nothing measured. Each of
those is counted as `unmeasured` (`x`) and surfaced in the dashboard, so a
silently failing precise mode shows up as a coverage gap instead of just
under-reporting the decoded column.

WebSocket payloads and DNS/TLS bytes remain out of scope: `webRequest` sees only
the WebSocket handshake, and no WebExtension API exposes handshake byte counts.

### What `Content-Length` actually means

`Content-Length` is the size of the response **body on the wire**. When the
response is compressed (`Content-Encoding: gzip/br`), that is the compressed
size — which is exactly what "data downloaded" should mean. It excludes request
headers, TLS overhead, and DNS. Those are documented as out of scope.

### Cached responses

A response served from the disk cache (`details.fromCache === true`) transferred
no bytes over the network. Counting it would inflate totals, so a cached response
is never added to the wire total `b`. Its count goes in a separate `c` counter and
its size in a separate `cb` (cached bytes) counter — the size is always recorded,
just kept apart, so the cached volume is visible without being mistaken for
network usage. There is no toggle: the two are simply never mixed.

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
    "b": 10485760,                 // wire bytes with known size (Content-Length)
    "r": 412,                      // requests seen, including u, c, e and nb below
    "u": 7,                        // subset of r: requests with unknown wire size
    "c": 33,                       // subset of r: requests served from disk cache
    "cb": 262144,                  // bytes of the cached responses (never in b)
    "d": 0,                        // decoded bytes (precise mode only)
    "dm": 0,                       // responses that contributed a d measurement
    "e": 2,                        // subset of r: requests that failed
    "x": 0,                        // precise-mode measurements that failed
    "nb": 0,                       // subset of r: responses with a known-empty body
    "er": {                        // failure reasons -> count
      "NS_ERROR_NET_TIMEOUT": 2
    },
    "h": {                         // per serving-host breakdown
      "cdn.example.com": { "b": 9437184, "r": 300, "u": 2, "c": 10, "cb": 262144, "d": 0, "dm": 0, "e": 1, "x": 0, "nb": 0, "er": { "NS_ERROR_NET_TIMEOUT": 1 } }
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
- **`er`** is a small histogram bounded by the number of distinct error codes, so
  "why did requests fail" is answerable without the opt-in per-request log.

**Counts are nested, not disjoint.** `r` is the umbrella: every observed request
is counted there, and `u`, `c`, `e` and `nb` are subsets of it. A cached response
is in both `r` and `c`; a failed request is in both `r` and `e`. Empty-body
responses are in `r` and `nb` and count as a *known* zero in coverage. The
dashboard's Requests column shows `r`. The known-size percentage is
`(r - u - c - e) / (r - c)`: cached hits are removed from both sides because they
moved no network bytes, while unknown-size and failed requests stay in the
denominator as coverage gaps.

The optional per-request log lives in a *separate* key space, `log:YYYY-MM-DD`
(an array of request rows), so the aggregate buckets stay small and a log row is
never confused with a bucket. Both are pruned together and cleared together.

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
startup, and — crucially — they are registered **synchronously at the top level**
of the page. An event page only restarts for events whose listeners were present
during the synchronous first run; registering `onCompleted` after an `await`
would mean the page is no longer woken by completed requests, silently losing
them. Loading persisted settings is therefore deferred until after the listeners
are live, and the collector treats a not-yet-loaded setting as its default.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` | Observe completed requests |
| `<all_urls>` host permission | Required by `webRequest` to observe requests to a host; measuring all sites inherently needs all hosts |
| `storage` | Persist the local log |
| `unlimitedStorage` | Avoid the storage quota for long histories (still pruned by retention) |
| `alarms` | Periodic flush + retention pruning |
| `webRequestBlocking` (optional) | Precise mode only: register a blocking listener and call `filterResponseData` |
| `webRequestFilterResponse` (optional) | Precise mode only: required by MV3 to filter response bodies |

The two optional permissions are requested from the dashboard toggle when precise
mode is first enabled, and revoked state is handled by falling back to the
default observational listener.

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
- In the site view, clicking a row expands it into the per-host breakdown that
  made up that site's total (from the same `h` map the day buckets already keep),
  so "which servers did this site actually pull from" is one click away.
- Site filter (substring match + include/exclude the top N).
- Results table: wire bytes, decoded bytes (precise mode only), cached bytes,
  requests, cached count, empty-body count, unknown wire size count, errored
  count, and unmeasured (precise-mode gap) count. The two precise-mode columns
  appear only while precise mode is selected, so the table does not show a
  decoded column with no measurements behind it.
- Each row's errored count is a hover/tap target that lists that row's
  error-reason histogram, so the errored count is explained rather than just
  shown.
- Totals, including the share of responses that have a known wire size, and a
  **CSV export** of the current filtered view.
- **Download detailed log** — the opt-in per-request log for the current range as
  CSV (time, site, serving host, type, status, wire bytes, cached bytes, decoded
  bytes, cached, empty body, error), for comparing the two byte metrics request
  by request.

The popup shows today's wire total, today's decoded total when precise mode has
measured anything, and the top few sites.

## Known limitations

- Responses without `Content-Length` are counted as "unknown", not zero. A
  response with a **known-empty body** (1xx, 204, 205, 304, or any answer to a
  HEAD) is the exception: its content size is a real zero, so it is counted as
  known and not as a coverage gap. Any `Content-Length` a 304 carries describes
  the cached representation and is never added to the wire total.
- Failed or cancelled requests are counted as "errored", not zero: they may have
  transferred bytes we can never see.
- Request headers, TLS, DNS, and QUIC overhead are not counted. The totals are
  **response bodies on the wire** (`Content-Length`), so they undercount the true
  link usage by roughly the header/TLS overhead per request. For a per-app data
  comparison, see the note on uplink and headers in README.
- Outbound (upload) bytes are not counted at all: `Content-Length` on a response
  describes only what was downloaded.
- WebSocket payloads (only the handshake is visible), WebRTC media/data, and
  browser-internal traffic (telemetry, Sync, updates) never reach `webRequest`,
  so no extension can measure them. On Android these can dwarf measurable
  browsing traffic.
- Traffic in private tabs is only counted if the extension is enabled there.
- Registrable-domain reduction is approximate (embedded suffix list).
- Nested-iframe attribution uses the iframe document, not the top page.
- Data is per browser profile; it does not sync.
- Precise mode's decoded byte counts include responses served from the disk
  cache, because a stream filter measures the body that is delivered to the page
  regardless of where it came from. The wire column still excludes cached
  responses (their bytes are in the separate cached-bytes column); the two
  columns are therefore not a strict like-for-like comparison.
- Precise mode cannot see WebSocket payloads (only the HTTP handshake passes
  through `webRequest`), and it adds the extension to the blocking path of every
  response while enabled.
- The opt-in detailed log is capped per day (`MAX_LOG_ENTRIES_PER_DAY`); past the
  cap, later rows are dropped from the log (the aggregate buckets are unaffected).
  An error reason is taken from `details.error` and is not normalised, so the same
  underlying failure can appear under more than one code.

## Possible extensions

- Full Public Suffix List for exact eTLD+1.
- Weekly/monthly roll-ups stored alongside daily buckets.
- Per-tab live meter using `webRequest` + `tabs` events.
- Per-request-type breakdown (script vs image vs xmlhttprequest). `details.type`
  is already stored on every detailed-log row; only the aggregate view omits it.
