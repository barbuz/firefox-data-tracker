// Per-request / per-error log. This is the *only* place the extension keeps one
// row per request, which is exactly what makes a wire-vs-decoded comparison and
// an error-reason breakdown possible — the aggregate day buckets cannot answer
// "which request, and why did it fail".
//
// It is opt-in (settings.requestLog) precisely because per-request volume is
// unbounded where aggregate volume is not, and it is capped per day by the Store
// so a heavy session cannot grow storage without limit.
//
// Only hostnames/sizes/timestamps are kept — never the full URL, headers or body
// — so the log respects the same privacy rule as the rest of the extension.
//
// Pure functions over plain objects, no browser globals, so they are unit-tested
// directly under Node.

/**
 * One row for a request that completed. `bytes` is Content-Length, or null when
 * the response had no known size (chunked/streamed). `d` is filled in later if
 * precise mode measures the response.
 *
 * A response served from disk cache moved no network bytes, so its size is kept
 * in `cb` (cached bytes) and `b` stays null — the same separation the day buckets
 * use, so summing `b` over the log matches the dashboard's network-only Wire
 * column.
 *
 * Keys are short because there can be many rows; the serializers below expand
 * them to readable column names.
 */
export function completedEntry({ timeStamp, site, host, type, bytes, fromCache }) {
  const size = bytes == null ? null : bytes;
  return {
    t: timeStamp,
    site,
    host,
    type: type || "",
    b: fromCache ? null : size,
    cb: fromCache ? size : null,
    c: fromCache ? 1 : 0,
    d: null,
    e: "",
  };
}

/**
 * One row for a request that failed (webRequest.onErrorOccurred). It carries no
 * size — it may have transferred bytes we can never see — but it does carry the
 * error reason, which is what makes failures diagnosable.
 */
export function erroredEntry({ timeStamp, site, host, type, reason }) {
  return {
    t: timeStamp,
    site,
    host,
    type: type || "",
    b: null,
    cb: null,
    c: 0,
    d: null,
    e: reason || "unknown",
  };
}

/** Fold a precise-mode measurement into the row for the same request. */
export function addDecoded(entry, decodedBytes) {
  if (decodedBytes > 0) entry.d = (entry.d || 0) + decodedBytes;
  return entry;
}

const CSV_HEADER = "time,site,host,type,wire_bytes,cached_bytes,decoded_bytes,cached,error";

/** Serialize log rows to CSV. Null sizes (unknown / errored) render as empty. */
export function entriesToCsv(entries) {
  const lines = entries.map((e) =>
    [
      new Date(e.t).toISOString(),
      csvCell(e.site),
      csvCell(e.host),
      csvCell(e.type),
      e.b == null ? "" : e.b,
      e.cb == null ? "" : e.cb,
      e.d == null ? "" : e.d,
      e.c ? "yes" : "no",
      csvCell(e.e || ""),
    ].join(",")
  );
  return [CSV_HEADER, ...lines].join("\n");
}

function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
