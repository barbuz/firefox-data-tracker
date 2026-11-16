import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dateKey,
  contentLengthFromHeaders,
  accumulate,
  mergeDay,
  aggregate,
  sumRows,
  dateRange,
  formatBytes,
  rowsToCsv,
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
  assert.equal(s.h["cdn.example.com"].b, 1500);
  assert.equal(s.h["example.com"].c, 1);
  assert.equal(s.h["example.com"].b, 0, "cached bytes are not counted");
});

test("accumulate ignores requests with no attributable site", () => {
  const day = {};
  accumulate(day, { site: "", host: "x", bytes: 10, fromCache: false });
  assert.deepEqual(day, {});
});

test("mergeDay sums counters across buckets without mutating inputs", () => {
  const a = {};
  accumulate(a, { site: "example.com", host: "example.com", bytes: 100, fromCache: false });
  const b = {};
  accumulate(b, { site: "example.com", host: "example.com", bytes: 200, fromCache: false });

  const merged = mergeDay(a, b);
  assert.equal(merged["example.com"].b, 300);
  assert.equal(merged["example.com"].r, 2);
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
    { key: "a", bytes: 100, requests: 2, unknown: 0, cached: 1 },
    { key: "b", bytes: 50, requests: 1, unknown: 1, cached: 0 },
  ];
  assert.deepEqual(sumRows(rows), { bytes: 150, requests: 3, unknown: 1, cached: 1 });
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
  const csv = rowsToCsv([{ key: 'a,"b"', bytes: 1, requests: 2, unknown: 3, cached: 4 }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "key,bytes,requests,unknown_size,cached");
  assert.equal(lines[1], '"a,""b""",1,2,3,4');
});
