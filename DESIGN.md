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
| `filterResponseData` → sum `ondata` byte lengths | Counts the bytes each response actually delivers, **after** content conversion (decompressed) | Intercepts every response body; runs code per chunk | `webRequest`, `webRequestBlocking`, `webRequestFilterResponse` + host permissions |

We default to the **header approach** because it is genuinely lightweight: the
listener is *informational only* (see MDN: "This event is informational only"),
so it never adds latency to a page load. We record a count of responses with
**unknown size** so the coverage gap is visible instead of silently wrong.

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

WebSocket payloads and DNS/TLS bytes remain out of scope: `webRequest` sees only
the WebSocket handshake, and no WebExtension API exposes handshake byte counts.

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
    "b": 10485760,                 // wire bytes with known size (Content-Length)
    "r": 412,                      // completed requests
    "u": 7,                        // requests with unknown size (no Content-Length)
    "c": 33,                       // requests served from cache (excluded from b)
    "d": 0,                        // decoded bytes (precise mode only)
    "dm": 0,                       // responses that contributed a d measurement
    "h": {                         // per serving-host breakdown
      "cdn.example.com": { "b": 9437184, "r": 300, "u": 2, "c": 10, "d": 0, "dm": 0 }
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
- Site filter (substring match + include/exclude the top N).
- Sortable table: wire bytes (with bar), decoded bytes (precise mode only),
  requests, unknown-size count, cached count.
- Totals, including the share of responses that have a known wire size, and a
  **CSV export** of the current filtered view.

The popup shows today's wire total, today's decoded total when precise mode has
measured anything, and the top few sites.

## Known limitations

- Responses without `Content-Length` are counted as "unknown", not zero.
- Request headers, TLS, DNS, and QUIC overhead are not counted.
- Registrable-domain reduction is approximate (embedded suffix list).
- Nested-iframe attribution uses the iframe document, not the top page.
- Data is per browser profile; it does not sync.
- Precise mode's decoded byte counts include responses served from the disk
  cache, because a stream filter measures the body that is delivered to the page
  regardless of where it came from. The wire column still excludes cached
  responses under `excludeCached`; the two columns are therefore not a strict
  like-for-like comparison.
- Precise mode cannot see WebSocket payloads (only the HTTP handshake passes
  through `webRequest`), and it adds the extension to the blocking path of every
  response while enabled.

## Possible extensions

- Full Public Suffix List for exact eTLD+1.
- Weekly/monthly roll-ups stored alongside daily buckets.
- Per-tab live meter using `webRequest` + `tabs` events.
- Per-request-type breakdown (script vs image vs xmlhttprequest). `details.type`
  is already available on every event; it is simply not stored yet.
