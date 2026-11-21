import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dateKey,
  contentLengthFromHeaders,
  isBodylessStatus,
  accumulate,
  mergeDay,
  aggregate,
  hostBreakdown,
  sumRows,
  dateRange,
  formatBytes,
  rowsToCsv,
  coverage,
  errorReasons,
} from "../src/lib/aggregate.js";

test("dateKey formats local calendar dates", () => {
  const d = new Date(2026, 0, 5, 13, 30); // 2026-01-05 local
  assert.equal(dateKey(d.getTime()), "2026-01-05");
});

test("contentLengthFromHeaders is case-insensitive and validates", () => {
  assert.equal(contentLengthFromHeaders([{ name: "Content-Length", value: "1234" }]), 1234);
  assert.equal(contentLengthFromHeaders([{ name: "content-length", value: "10" }]), 10);
  assert.equal(contentLengthFromHeaders([{ name: "X-Other", value: "5" }]), null);
  assert.equal(contentLengthFromHeaders([{ name: "Content-Length", value: "abc" }]), null);
  assert.equal(contentLengthFromHeaders([{ name: "Content-Length", value: "-5" }]), null);
  assert.equal(contentLengthFromHeaders(undefined), null);
});

test("accumulate folds requests, bytes, unknown and cached", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: 1000, fromCache: false });
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: 500, fromCache: false });
  accumulate(day, { site: "example.com", host: "example.com", bytes: null, fromCache: false });
  accumulate(day, { site: "example.com", host: "example.com", bytes: 9999, fromCache: true });

  const s = day["example.com"];
  assert.equal(s.b, 1500);
  assert.equal(s.r, 4);
  assert.equal(s.u, 1);
  assert.equal(s.c, 1);
  assert.equal(s.cb, 9999, "cached bytes are recorded in their own field");
  assert.equal(s.h["cdn.example.com"].b, 1500);
  assert.equal(s.h["example.com"].c, 1);
  assert.equal(s.h["example.com"].cb, 9999, "per-host cached bytes too");
  assert.equal(s.h["example.com"].b, 0, "cached bytes never enter the network total");
});

test("requests is the umbrella count for every observed request", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "h", bytes: 10 });
  accumulate(day, { site: "example.com", host: "h", bytes: null });
  accumulate(day, { site: "example.com", host: "h", bytes: null, bodyless: true });
  accumulate(day, { site: "example.com", host: "h", bytes: 5, fromCache: true });
  accumulate(day, { site: "example.com", host: "h", bytes: null, errored: true });

  const s = day["example.com"];
  assert.equal(s.r, 5, "every observed request is counted once");
  assert.equal(s.u, 1);
  assert.equal(s.nb, 1);
  assert.equal(s.c, 1);
  assert.equal(s.e, 1);
});

test("accumulate ignores requests with no attributable site", () => {
  const day = {};
  accumulate(day, { site: "", host: "x", bytes: 10, fromCache: false });
  assert.deepEqual(day, {});
});

test("isBodylessStatus recognises the bodyless statuses and HEAD", () => {
  assert.equal(isBodylessStatus(204), true);
  assert.equal(isBodylessStatus(205), true);
  assert.equal(isBodylessStatus(304), true);
  assert.equal(isBodylessStatus(100), true, "1xx informational");
  assert.equal(isBodylessStatus(199), true);
  assert.equal(isBodylessStatus(200, "HEAD"), true, "a HEAD response has no body");
  assert.equal(isBodylessStatus(200), false);
  assert.equal(isBodylessStatus(206), false, "a partial response does have a body");
  assert.equal(isBodylessStatus(301), false, "a redirect can carry a body");
  assert.equal(isBodylessStatus(undefined), false);
});

test("accumulate counts a bodyless response as a known zero, not an unknown", () => {
  const day = {};
  // A 304 may carry the cached Content-Length; it must not become wire bytes,
  // and it must not be counted as an unknown-size gap either.
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: null, fromCache: false, bodyless: true });

  const s = day["example.com"];
  assert.equal(s.r, 1, "it is still a request");
  assert.equal(s.nb, 1, "counted as a known-empty body");
  assert.equal(s.u, 0, "not an unknown-size gap");
  assert.equal(s.b, 0, "and no bytes are attributed");
  assert.equal(s.h["cdn.example.com"].nb, 1);

  // Coverage treats it as known: it is not a blind spot.
  assert.equal(coverage({ requests: 1, unknown: 0, cached: 0, errored: 0 }), 1);
});

test("mergeDay and the row builders carry the bodyless counter", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "h", bytes: null, fromCache: false, bodyless: true });
  accumulate(day, { site: "example.com", host: "h", bytes: null, fromCache: false, bodyless: true });

  const merged = mergeDay(mergeDay({}, day), day);
  assert.equal(merged["example.com"].nb, 4);

  const rows = aggregate([{ date: "2026-01-01", data: day }], { groupBy: "site" });
  assert.equal(rows[0].bodyless, 2);
  assert.equal(sumRows(rows).bodyless, 2);
});

test("accumulate counts errored requests as a request with no known size", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: null, fromCache: false, errored: true });

  const s = day["example.com"];
  assert.equal(s.r, 1, "an errored request is still a request");
  assert.equal(s.e, 1, "and is flagged as errored");
  assert.equal(s.b, 0, "no wire bytes are attributed");
  assert.equal(s.u, 0, "it is not also an unknown-size response");
  assert.equal(s.h["cdn.example.com"].e, 1);
});

test("accumulate records an error reason histogram per site and host", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: null, fromCache: false, errored: true, errorReason: "NS_ERROR_NET_TIMEOUT" });
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: null, fromCache: false, errored: true, errorReason: "NS_ERROR_NET_TIMEOUT" });
  accumulate(day, { site: "example.com", host: "ads.net", bytes: null, fromCache: false, errored: true, errorReason: "NS_ERROR_ABORT" });
  // A missing reason is folded under "unknown" rather than dropped.
  accumulate(day, { site: "example.com", host: "ads.net", bytes: null, fromCache: false, errored: true });

  const s = day["example.com"];
  assert.deepEqual(s.er, { NS_ERROR_NET_TIMEOUT: 2, NS_ERROR_ABORT: 1, unknown: 1 });
  assert.deepEqual(s.h["cdn.example.com"].er, { NS_ERROR_NET_TIMEOUT: 2 });
  assert.deepEqual(s.h["ads.net"].er, { NS_ERROR_ABORT: 1, unknown: 1 });
});

test("mergeDay sums error reason histograms", () => {
  const a = {};
  accumulate(a, { site: "example.com", host: "h", bytes: null, fromCache: false, errored: true, errorReason: "X" });
  const b = {};
  accumulate(b, { site: "example.com", host: "h", bytes: null, fromCache: false, errored: true, errorReason: "X" });
  accumulate(b, { site: "example.com", host: "h", bytes: null, fromCache: false, errored: true, errorReason: "Y" });

  const merged = mergeDay(a, b);
  assert.deepEqual(merged["example.com"].er, { X: 2, Y: 1 });
  assert.deepEqual(merged["example.com"].h.h.er, { X: 2, Y: 1 });
  assert.deepEqual(a["example.com"].er, { X: 1 }, "source bucket is not mutated");
});

test("errorReasons flattens rows into a descending reason list", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "a.net", bytes: null, fromCache: false, errored: true, errorReason: "TIMEOUT" });
  accumulate(day, { site: "other.com", host: "b.net", bytes: null, fromCache: false, errored: true, errorReason: "TIMEOUT" });
  accumulate(day, { site: "other.com", host: "b.net", bytes: null, fromCache: false, errored: true, errorReason: "ABORT" });
  const rows = aggregate([{ date: "2026-01-01", data: day }], { groupBy: "site" });

  assert.deepEqual(errorReasons(rows), [
    { reason: "TIMEOUT", count: 2 },
    { reason: "ABORT", count: 1 },
  ]);
});

test("accumulate counts an unmeasured response without touching wire counters", () => {
  const day = {};
  // The wire event already counted the request as unknown-size...
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: null, fromCache: false });
  // ...then precise mode failed to measure it.
  accumulate(day, {
    site: "example.com",
    host: "cdn.example.com",
    bytes: null,
    fromCache: false,
    unmeasured: true,
    countRequest: false,
    wireAccounting: false,
  });

  const s = day["example.com"];
  assert.equal(s.r, 1, "the request is not double-counted");
  assert.equal(s.x, 1, "the measurement gap is recorded");
  assert.equal(s.u, 1, "still unknown size on the wire");
});

test("mergeDay sums counters across buckets without mutating inputs", () => {
  const a = {};
  accumulate(a, { site: "example.com", host: "example.com", bytes: 100, fromCache: false });
  accumulate(a, { site: "example.com", host: "example.com", bytes: 10, fromCache: true });
  const b = {};
  accumulate(b, { site: "example.com", host: "example.com", bytes: 200, fromCache: false });
  accumulate(b, { site: "example.com", host: "example.com", bytes: 20, fromCache: true });

  const merged = mergeDay(a, b);
  assert.equal(merged["example.com"].b, 300);
  assert.equal(merged["example.com"].r, 4);
  assert.equal(merged["example.com"].c, 2);
  assert.equal(merged["example.com"].cb, 30, "cached bytes merge too");
  assert.equal(merged["example.com"].h["example.com"].cb, 30, "and per host");
  assert.equal(a["example.com"].b, 100, "source bucket unchanged");
});

test("aggregate groups by site and by serving host", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "cdn.net", bytes: 100, fromCache: false });
  accumulate(day, { site: "example.com", host: "cdn.net", bytes: 50, fromCache: false });
  accumulate(day, { site: "other.com", host: "other.com", bytes: 400, fromCache: false });
  const days = [{ date: "2026-01-01", data: day }];

  const bySite = aggregate(days, { groupBy: "site" });
  assert.deepEqual(bySite.map((r) => r.key), ["other.com", "example.com"]);
  assert.equal(bySite.find((r) => r.key === "example.com").bytes, 150);

  const byHost = aggregate(days, { groupBy: "host" });
  assert.equal(byHost.find((r) => r.key === "cdn.net").bytes, 150);
});

test("hostBreakdown lists a site's hosts, largest first", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "cdn.net", bytes: 100, fromCache: false });
  accumulate(day, { site: "example.com", host: "cdn.net", bytes: 50, fromCache: false });
  accumulate(day, { site: "example.com", host: "example.com", bytes: 400, fromCache: false });
  accumulate(day, { site: "example.com", host: "tracker.io", bytes: null, fromCache: false });
  accumulate(day, { site: "other.com", host: "other.com", bytes: 999, fromCache: false });
  const days = [{ date: "2026-01-01", data: day }];

  const hosts = hostBreakdown(days, "example.com");
  assert.deepEqual(hosts.map((r) => r.key), ["example.com", "cdn.net", "tracker.io"]);
  assert.equal(hosts[0].bytes, 400);
  assert.equal(hosts[1].bytes, 150, "the two cdn.net requests are folded together");
  assert.equal(hosts[1].requests, 2);
  assert.equal(hosts[2].unknown, 1);
});

test("hostBreakdown sums a host across multiple days", () => {
  const a = {};
  accumulate(a, { site: "example.com", host: "cdn.net", bytes: 100, fromCache: false });
  const b = {};
  accumulate(b, { site: "example.com", host: "cdn.net", bytes: 250, fromCache: false });
  const days = [{ date: "2026-01-01", data: a }, { date: "2026-01-02", data: b }];

  const hosts = hostBreakdown(days, "example.com");
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].bytes, 350);
  assert.equal(hosts[0].requests, 2);
});

test("hostBreakdown of an unknown site is empty", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "cdn.net", bytes: 100, fromCache: false });
  assert.deepEqual(hostBreakdown([{ date: "2026-01-01", data: day }], "missing.com"), []);
});

test("aggregate supports substring filter and top-N", () => {
  const day = {};
  accumulate(day, { site: "example.com", host: "example.com", bytes: 100, fromCache: false });
  accumulate(day, { site: "example.org", host: "example.org", bytes: 300, fromCache: false });
  accumulate(day, { site: "other.net", host: "other.net", bytes: 200, fromCache: false });
  const days = [{ date: "2026-01-01", data: day }];

  const filtered = aggregate(days, { groupBy: "site", siteFilter: "example" });
  assert.deepEqual(filtered.map((r) => r.key).sort(), ["example.com", "example.org"]);

  const top = aggregate(days, { groupBy: "site", topSites: 2 });
  assert.deepEqual(top.map((r) => r.key), ["example.org", "other.net"]);
});

test("sumRows totals the aggregate output", () => {
  const rows = [
    { key: "a", bytes: 100, requests: 2, unknown: 0, cached: 1, cachedBytes: 40, decoded: 30, measured: 1, errored: 0, unmeasured: 0 },
    { key: "b", bytes: 50, requests: 1, unknown: 1, cached: 0, cachedBytes: 0, decoded: 0, measured: 0, errored: 1, unmeasured: 2 },
  ];
  assert.deepEqual(sumRows(rows), {
    bytes: 150, requests: 3, unknown: 1, cached: 1, cachedBytes: 40, decoded: 30, measured: 1, errored: 1, unmeasured: 2, bodyless: 0,
  });
});

test("coverage reports the share of responses with a known wire size", () => {
  // 3 of 4 countable responses have a size (cached hits are not counted).
  assert.equal(
    coverage({ bytes: 0, requests: 5, unknown: 1, cached: 1, decoded: 0, measured: 0, errored: 0 }),
    0.75
  );
  // Failed requests are blind spots: they count against coverage.
  // 3 of 5 countable responses have a size (5 requests, 1 unknown, 1 errored).
  assert.equal(
    coverage({ bytes: 0, requests: 5, unknown: 1, cached: 0, decoded: 0, measured: 0, errored: 1 }),
    0.6
  );
  // Everything errored: no known sizes at all.
  assert.equal(
    coverage({ bytes: 0, requests: 1, unknown: 0, cached: 0, decoded: 0, measured: 0, errored: 1 }),
    0
  );
  // Nothing countable at all is treated as fully covered, not as 0.
  assert.equal(
    coverage({ bytes: 0, requests: 2, unknown: 0, cached: 2, decoded: 0, measured: 0, errored: 0 }),
    1
  );
  assert.equal(
    coverage({ bytes: 0, requests: 0, unknown: 0, cached: 0, decoded: 0, measured: 0, errored: 0 }),
    1
  );
});

test("dateRange is inclusive and ordered", () => {
  assert.deepEqual(dateRange("2026-01-01", "2026-01-04"), [
    "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
  ]);
  assert.deepEqual(dateRange("2026-01-01", "2026-01-01"), ["2026-01-01"]);
  assert.deepEqual(dateRange("bad", "2026-01-01"), []);
});

test("formatBytes uses binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
});

test("rowsToCsv escapes commas and quotes", () => {
  const csv = rowsToCsv([
    { key: 'a,"b"', bytes: 1, decoded: 9, requests: 2, unknown: 3, bodyless: 11, cached: 4, cachedBytes: 8, measured: 5, errored: 6, unmeasured: 7 },
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "key,bytes,decoded_bytes,requests,unknown_size,empty_body,cached,cached_bytes,decoded_measured,errored,unmeasured");
  assert.equal(lines[1], '"a,""b""",1,9,2,3,11,4,8,5,6,7');
});
