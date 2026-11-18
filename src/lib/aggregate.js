// Aggregation helpers. Pure functions over plain objects so the core accounting
// can be tested without a browser.

/** Local calendar date as "YYYY-MM-DD" for a given epoch-ms timestamp. */
export function dateKey(timestampMs) {
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Extract a byte count from response headers, or null when absent/invalid. */
export function contentLengthFromHeaders(headers) {
  if (!Array.isArray(headers)) return null;
  for (const h of headers) {
    if (h && typeof h.name === "string" && h.name.toLowerCase() === "content-length") {
      const n = Number(h.value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function emptyCounters() {
  // b: wire bytes (Content-Length) that crossed the network, r: requests,
  // u: unknown-size responses, c: disk-cache hits (a count, excluded from b),
  // cb: bytes of the cached responses (always recorded, never added to b),
  // d: decoded bytes measured by a stream filter,
  // dm: responses that contributed a decoded measurement,
  // e: requests that failed (webRequest.onErrorOccurred) — they may have
  //    transferred bytes we can never see, so they are a known blind spot,
  // x: responses precise mode tried but failed to measure (filter could not be
  //    attached, or was torn down before any bytes arrived),
  // er: failure reasons -> count, so "why did requests fail" is answerable
  //    without storing a row per request (defaults to {} for old buckets).
  return { b: 0, r: 0, u: 0, c: 0, cb: 0, d: 0, dm: 0, e: 0, x: 0, er: {} };
}

/**
 * Fold a single request (or a stream-filter measurement) into a day bucket.
 *
 * Decoded bytes are folded in *before* the early returns for cached and
 * unknown-size responses: a chunked/streamed response is exactly the case that
 * has no Content-Length, so returning early first would discard the very
 * measurement that makes it visible.
 *
 * @param {object} day        day bucket: { [site]: {b,r,u,c,cb,d,dm,h:{...}} }
 * @param {object} entry
 * @param {string} entry.site   registrable domain of the owning document
 * @param {string} entry.host   serving host
 * @param {number|null} entry.bytes  wire body size, or null when unknown
 * @param {boolean} entry.fromCache  whether the response came from disk cache;
 *        its bytes go to the separate `cb` counter and never to `b`
 * @param {number|null} [entry.decoded]  decoded bytes measured for this response
 * @param {boolean} [entry.measured]     true on the first measurement of a response
 * @param {boolean} [entry.unmeasured]   true when precise mode tried and failed to
 *        measure this response (filter not attached, or torn down early)
 * @param {boolean} [entry.errored]      true for a request that failed
 *        (webRequest.onErrorOccurred); it has no known size and may have
 *        transferred unseen bytes
 * @param {string} [entry.errorReason]   the failure reason for an errored request,
 *        folded into a per-bucket histogram so the causes are visible
 * @param {boolean} [entry.countRequest] false when the caller already counted the
 *        request (a stream measurement is a second event for the same request)
 * @param {boolean} [entry.wireAccounting] false to fold only the decoded bytes,
 *        leaving the wire counters (b/r/u/c) untouched
 */
export function accumulate(day, {
  site,
  host,
  bytes,
  fromCache,
  decoded = null,
  measured = false,
  unmeasured = false,
  errored = false,
  errorReason = null,
  countRequest = true,
  wireAccounting = true,
}) {
  if (!site) return day;
  let s = day[site];
  if (!s) s = day[site] = { ...emptyCounters(), h: {} };
  let h = host ? s.h[host] : null;
  if (host && !h) h = s.h[host] = emptyCounters();

  // A failed request is its own event: it is counted as a request (so it is
  // visible) and as errored (so its unseen bytes are not silently assumed to be
  // zero), but it carries no size, so no wire accounting is applied.
  if (errored) {
    if (countRequest) {
      s.r += 1;
      if (h) h.r += 1;
    }
    s.e += 1;
    if (h) h.e += 1;
    recordReason(s, errorReason);
    if (h) recordReason(h, errorReason);
    return day;
  }

  if (countRequest) {
    s.r += 1;
    if (h) h.r += 1;
  }

  if (measured) {
    s.dm += 1;
    if (h) h.dm += 1;
  }
  if (unmeasured) {
    s.x += 1;
    if (h) h.x += 1;
  }
  if (decoded != null && decoded > 0) {
    s.d += decoded;
    if (h) h.d += decoded;
  }

  if (!wireAccounting) return day;

  if (fromCache) {
    // Served from disk cache: no bytes crossed the network, so this is counted
    // separately. The bytes are still recorded (in `cb`) so the cached volume is
    // visible without being mixed into the network total `b`.
    s.c += 1;
    if (h) h.c += 1;
    if (bytes != null && bytes > 0) {
      s.cb += bytes;
      if (h) h.cb += bytes;
    }
    return day;
  }

  if (bytes == null) {
    s.u += 1;
    if (h) h.u += 1;
    return day;
  }

  s.b += bytes;
  if (h) h.b += bytes;
  return day;
}

/** Fold an error reason into a counters object's reason histogram. */
function recordReason(counters, reason) {
  const key = reason || "unknown";
  counters.er[key] = (counters.er[key] || 0) + 1;
}

/**
 * Merge a freshly collected day bucket into a stored one, returning a new
 * object. Used when flushing the in-memory buffer into storage so we never lose
 * counts accumulated by another context.
 */
export function mergeDay(target, source) {
  const out = target ? structuredCloneDay(target) : {};
  for (const [site, s] of Object.entries(source)) {
    let t = out[site];
    if (!t) t = out[site] = { ...emptyCounters(), h: {} };
    t.b += s.b || 0; t.r += s.r || 0; t.u += s.u || 0; t.c += s.c || 0;
    t.cb += s.cb || 0;
    t.d += s.d || 0; t.dm += s.dm || 0; t.e += s.e || 0; t.x += s.x || 0;
    mergeReasons(t, s.er);
    for (const [host, h] of Object.entries(s.h || {})) {
      let th = t.h[host];
      if (!th) th = t.h[host] = emptyCounters();
      th.b += h.b || 0; th.r += h.r || 0; th.u += h.u || 0; th.c += h.c || 0;
      th.cb += h.cb || 0;
      th.d += h.d || 0; th.dm += h.dm || 0; th.e += h.e || 0; th.x += h.x || 0;
      mergeReasons(th, h.er);
    }
  }
  return out;
}

function mergeReasons(target, source) {
  for (const [reason, n] of Object.entries(source || {})) {
    target.er[reason] = (target.er[reason] || 0) + (n || 0);
  }
}

function structuredCloneDay(day) {
  const out = {};
  for (const [site, s] of Object.entries(day)) {
    const h = {};
    for (const [host, c] of Object.entries(s.h || {})) {
      h[host] = { ...emptyCounters(), ...c, er: { ...(c.er || {}) } };
    }
    out[site] = {
      b: s.b, r: s.r, u: s.u, c: s.c, cb: s.cb || 0,
      d: s.d || 0, dm: s.dm || 0, e: s.e || 0, x: s.x || 0,
      er: { ...(s.er || {}) }, h,
    };
  }
  return out;
}

/**
 * Collapse a set of day buckets into a flat list of rows grouped by `site` or
 * `host`, honouring an optional site filter.
 *
 * @param {Array<{date:string, data:object}>} days
 * @param {object} opts
 * @param {"site"|"host"} opts.groupBy
 * @param {string} [opts.siteFilter]      substring match on the site name
 * @param {number} [opts.topSites]        when >0, restrict to the N largest sites
 * @returns {Array<{key:string, bytes:number, requests:number, unknown:number, cached:number, cachedBytes:number}>}
 */
export function aggregate(days, opts = {}) {
  const { groupBy = "site", siteFilter = "", topSites = 0 } = opts;
  const totals = new Map();

  for (const { data } of days) {
    for (const [site, s] of Object.entries(data || {})) {
      if (siteFilter && !site.toLowerCase().includes(siteFilter.toLowerCase())) continue;
      if (groupBy === "site") {
        addRow(totals, site, s);
      } else {
        for (const [host, h] of Object.entries(s.h || {})) addRow(totals, host, h);
      }
    }
  }

  let rows = [...totals.entries()].map(([key, v]) => ({ key, ...v }));
  rows.sort((a, b) => b.bytes - a.bytes);

  if (topSites > 0 && rows.length > topSites) {
    const keep = new Set(rows.slice(0, topSites).map((r) => r.key));
    rows = rows.filter((r) => keep.has(r.key));
  }
  return rows;
}

/**
 * Per-host breakdown for a single site, as rows shaped like aggregate()'s, so
 * the dashboard can show what a site's total is made of (which servers actually
 * served the bytes).
 *
 * No site filter here: the caller only expands sites that already passed the
 * filter in aggregate(), and this must list every host behind such a site.
 *
 * @param {Array<{date:string, data:object}>} days
 * @param {string} site
 * @returns {Array<{key:string, bytes:number, requests:number, unknown:number, cached:number, cachedBytes:number}>}
 */
export function hostBreakdown(days, site) {
  const totals = new Map();
  for (const { data } of days) {
    const s = data && data[site];
    if (!s) continue;
    for (const [host, h] of Object.entries(s.h || {})) addRow(totals, host, h);
  }
  const rows = [...totals.entries()].map(([key, v]) => ({ key, ...v }));
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows;
}

function addRow(map, key, c) {
  let row = map.get(key);
  if (!row) row = { bytes: 0, requests: 0, unknown: 0, cached: 0, cachedBytes: 0, decoded: 0, measured: 0, errored: 0, unmeasured: 0, reasons: {} };
  row.bytes += c.b;
  row.requests += c.r;
  row.unknown += c.u;
  row.cached += c.c;
  row.cachedBytes += c.cb || 0;
  row.decoded += c.d || 0;
  row.measured += c.dm || 0;
  row.errored += c.e || 0;
  row.unmeasured += c.x || 0;
  for (const [reason, n] of Object.entries(c.er || {})) {
    row.reasons[reason] = (row.reasons[reason] || 0) + n;
  }
  map.set(key, row);
}

/** Sum rows produced by aggregate(). */
export function sumRows(rows) {
  return rows.reduce(
    (acc, r) => ({
      bytes: acc.bytes + r.bytes,
      requests: acc.requests + r.requests,
      unknown: acc.unknown + r.unknown,
      cached: acc.cached + r.cached,
      cachedBytes: acc.cachedBytes + (r.cachedBytes || 0),
      decoded: acc.decoded + (r.decoded || 0),
      measured: acc.measured + (r.measured || 0),
      errored: acc.errored + (r.errored || 0),
      unmeasured: acc.unmeasured + (r.unmeasured || 0),
    }),
    { bytes: 0, requests: 0, unknown: 0, cached: 0, cachedBytes: 0, decoded: 0, measured: 0, errored: 0, unmeasured: 0 }
  );
}

/**
 * Flatten the error-reason histograms of a set of aggregate() rows into a
 * descending list of { reason, count }. This is what turns the single `errored`
 * count into an answer to "what are the main reasons for errors".
 */
export function errorReasons(rows) {
  const totals = new Map();
  for (const r of rows) {
    for (const [reason, n] of Object.entries(r.reasons || {})) {
      totals.set(reason, (totals.get(reason) || 0) + n);
    }
  }
  return [...totals.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * How much of the measured traffic has a known size. `unknown` responses have no
 * Content-Length (chunked, streamed, some 304s), so their bytes are missing from
 * the totals; `errored` requests are blind spots too (they may have transferred
 * bytes before failing), so both count against coverage. Cached hits moved no
 * network bytes, so they are left out of the ratio entirely. Returns a fraction
 * in [0,1]; 1 when there is nothing to report.
 */
export function coverage(totals) {
  const errored = totals.errored || 0;
  const known = totals.requests - totals.unknown - totals.cached - errored;
  const denom = known + totals.unknown + errored;
  if (denom <= 0) return 1;
  return known / denom;
}

/** Inclusive list of date keys between two "YYYY-MM-DD" strings. */
export function dateRange(from, to) {
  const out = [];
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
    out.push(dateKey(d.getTime()));
  }
  return out;
}

/** Human-readable byte formatting (base-1024). */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Build a CSV document from aggregate() rows. */
export function rowsToCsv(rows) {
  const header = "key,bytes,decoded_bytes,requests,unknown_size,cached,cached_bytes,decoded_measured,errored,unmeasured";
  const lines = rows.map((r) =>
    [
      csvCell(r.key),
      r.bytes,
      r.decoded || 0,
      r.requests,
      r.unknown,
      r.cached,
      r.cachedBytes || 0,
      r.measured || 0,
      r.errored || 0,
      r.unmeasured || 0,
    ].join(",")
  );
  return [header, ...lines].join("\n");
}

function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
