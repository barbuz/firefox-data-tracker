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
  return { b: 0, r: 0, u: 0, c: 0 };
}

/**
 * Fold a single completed request into a day bucket, in place.
 *
 * @param {object} day        day bucket: { [site]: {b,r,u,c,h:{[host]:{b,r,u,c}}} }
 * @param {object} entry
 * @param {string} entry.site   registrable domain of the owning document
 * @param {string} entry.host   serving host
 * @param {number|null} entry.bytes  body size, or null when unknown
 * @param {boolean} entry.fromCache  whether the response came from disk cache
 */
export function accumulate(day, { site, host, bytes, fromCache }) {
  if (!site) return day;
  let s = day[site];
  if (!s) s = day[site] = { ...emptyCounters(), h: {} };
  let h = host ? s.h[host] : null;
  if (host && !h) h = s.h[host] = emptyCounters();

  s.r += 1;
  if (h) h.r += 1;

  if (fromCache) {
    // Served from disk cache: no bytes crossed the network.
    s.c += 1;
    if (h) h.c += 1;
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
    t.b += s.b; t.r += s.r; t.u += s.u; t.c += s.c;
    for (const [host, h] of Object.entries(s.h || {})) {
      let th = t.h[host];
      if (!th) th = t.h[host] = emptyCounters();
      th.b += h.b; th.r += h.r; th.u += h.u; th.c += h.c;
    }
  }
  return out;
}

function structuredCloneDay(day) {
  const out = {};
  for (const [site, s] of Object.entries(day)) {
    const h = {};
    for (const [host, c] of Object.entries(s.h || {})) h[host] = { ...c };
    out[site] = { b: s.b, r: s.r, u: s.u, c: s.c, h };
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
 * @returns {Array<{key:string, bytes:number, requests:number, unknown:number, cached:number}>}
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

function addRow(map, key, c) {
  let row = map.get(key);
  if (!row) row = { bytes: 0, requests: 0, unknown: 0, cached: 0 };
  row.bytes += c.b;
  row.requests += c.r;
  row.unknown += c.u;
  row.cached += c.c;
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
    }),
    { bytes: 0, requests: 0, unknown: 0, cached: 0 }
  );
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
  const header = "key,bytes,requests,unknown_size,cached";
  const lines = rows.map((r) =>
    [csvCell(r.key), r.bytes, r.requests, r.unknown, r.cached].join(",")
  );
  return [header, ...lines].join("\n");
}

function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
