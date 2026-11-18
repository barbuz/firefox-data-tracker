import { test } from "node:test";
import assert from "node:assert/strict";

import {
  completedEntry,
  erroredEntry,
  addDecoded,
  entriesToCsv,
} from "../src/lib/requestlog.js";

test("completedEntry captures size, cache flag and type", () => {
  const e = completedEntry({
    timeStamp: Date.UTC(2026, 0, 5, 12, 0, 0),
    site: "example.com",
    host: "cdn.example.com",
    type: "script",
    bytes: 2048,
    fromCache: false,
  });
  assert.equal(e.site, "example.com");
  assert.equal(e.host, "cdn.example.com");
  assert.equal(e.type, "script");
  assert.equal(e.b, 2048);
  assert.equal(e.cb, null, "not a cache hit, so no cached bytes");
  assert.equal(e.c, 0);
  assert.equal(e.d, null);
  assert.equal(e.e, "");
});

test("completedEntry records an unknown size as null, not zero", () => {
  const e = completedEntry({ timeStamp: 0, site: "s", host: "h", type: "", bytes: null, fromCache: true });
  assert.equal(e.b, null, "unknown size must stay null so it is not read as 0 bytes");
  assert.equal(e.c, 1);
});

test("completedEntry keeps cached bytes out of the wire column", () => {
  const e = completedEntry({ timeStamp: 0, site: "s", host: "h", type: "image", bytes: 4096, fromCache: true });
  assert.equal(e.b, null, "cached bytes never enter the wire column");
  assert.equal(e.cb, 4096, "they are recorded separately");
  assert.equal(e.c, 1);
});

test("erroredEntry carries the reason and no size", () => {
  const e = erroredEntry({ timeStamp: 0, site: "s", host: "h", type: "xmlhttprequest", reason: "NS_ERROR_NET_TIMEOUT" });
  assert.equal(e.b, null);
  assert.equal(e.e, "NS_ERROR_NET_TIMEOUT");
});

test("erroredEntry falls back to a stable label when the reason is missing", () => {
  const e = erroredEntry({ timeStamp: 0, site: "s", host: "h", type: "", reason: undefined });
  assert.equal(e.e, "unknown");
});

test("addDecoded accumulates decoded bytes onto the same row", () => {
  const e = completedEntry({ timeStamp: 0, site: "s", host: "h", type: "", bytes: null, fromCache: false });
  addDecoded(e, 1200);
  addDecoded(e, 800);
  assert.equal(e.d, 2000);
  addDecoded(e, 0);
  assert.equal(e.d, 2000, "a zero-byte measurement does not change the row");
});

test("entriesToCsv emits a header and one row per entry with blanks for unknown sizes", () => {
  const rows = [
    completedEntry({ timeStamp: Date.UTC(2026, 0, 5, 12, 0, 0), site: "example.com", host: "cdn.example.com", type: "script", bytes: 2048, fromCache: false }),
    erroredEntry({ timeStamp: Date.UTC(2026, 0, 5, 12, 0, 1), site: "example.com", host: "ads.net", type: "image", reason: "NS_ERROR_ABORT" }),
  ];
  const lines = entriesToCsv(rows).split("\n");
  assert.equal(lines[0], "time,site,host,type,wire_bytes,cached_bytes,decoded_bytes,cached,error");
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith("2026-01-05T12:00:00.000Z,example.com,cdn.example.com,script,2048,,,no,"));
  // Errored row: no wire bytes (blank), reason present.
  assert.ok(lines[2].endsWith(",ads.net,image,,,,no,NS_ERROR_ABORT"));
});

test("entriesToCsv escapes commas and quotes in fields", () => {
  const rows = [completedEntry({ timeStamp: 0, site: 'a,"b"', host: "h", type: "", bytes: 1, fromCache: false })];
  const line = entriesToCsv(rows).split("\n")[1];
  assert.ok(line.includes('"a,""b"""'));
});
