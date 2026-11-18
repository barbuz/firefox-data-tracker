// End-to-end smoke test: drive the real Collector -> Store -> aggregate pipeline
// with a simulated browsing session and assert the numbers a user would see.
// Only browser.storage is faked; all accounting code is the real thing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "../src/lib/store.js";
import { Collector } from "../src/lib/collector.js";
import { aggregate, dateRange, sumRows, formatBytes, coverage, errorReasons } from "../src/lib/aggregate.js";
import { entriesToCsv } from "../src/lib/requestlog.js";

class FakeArea {
  constructor() { this.data = {}; }
  async get(keys) {
    if (keys === null || keys === undefined) return structuredClone(this.data);
    const arr = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of arr) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items) { Object.assign(this.data, structuredClone(items)); }
  async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k]; }
}

const DAY = new Date(2026, 2, 10, 10, 0).getTime(); // 2026-03-10 local
const req = (over) => ({
  type: "sub_frame",
  timeStamp: DAY,
  fromCache: false,
  documentUrl: "https://www.news.example/",
  url: "https://www.news.example/",
  responseHeaders: [{ name: "Content-Length", value: "0" }],
  ...over,
});

test("simulated session produces the expected dashboard view", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  const session = [
    // Top-level document for a news site.
    req({ type: "main_frame", documentUrl: undefined, url: "https://www.news.example/article", responseHeaders: [{ name: "Content-Length", value: "200000" }] }),
    // Same site's own assets + a third-party CDN and ad network.
    req({ type: "script", url: "https://www.news.example/app.js", responseHeaders: [{ name: "Content-Length", value: "300000" }] }),
    req({ type: "image", url: "https://cdn.assets.net/hero.jpg", responseHeaders: [{ name: "Content-Length", value: "500000" }] }),
    req({ type: "xmlhttprequest", url: "https://ads.tracker.io/pixel", responseHeaders: [] }), // unknown size
    req({ type: "image", url: "https://cdn.assets.net/logo.png", fromCache: true, responseHeaders: [{ name: "Content-Length", value: "4000" }] }), // cached
    // A different site.
    req({ type: "main_frame", documentUrl: undefined, url: "https://shop.example.org/", responseHeaders: [{ name: "Content-Length", value: "100000" }] }),
  ];
  for (const r of session) collector.handleCompleted(r);

  // Flush without waiting on the debounce timer.
  await collector.flush();

  const days = await store.getDays(dateRange("2026-03-10", "2026-03-10"));
  assert.equal(days.length, 1);

  const bySite = aggregate(days, { groupBy: "site" });
  const news = bySite.find((r) => r.key === "news.example");
  const shop = bySite.find((r) => r.key === "example.org");

  // news.example owns its own 500k plus the third-party CDN 500k and the
  // unknown-size ad pixel; the cached logo's 4k is recorded separately, not in b.
  assert.equal(news.bytes, 1000000);
  assert.equal(news.requests, 5);
  assert.equal(news.unknown, 1);
  assert.equal(news.cached, 1);
  assert.equal(news.cachedBytes, 4000, "cached bytes kept in their own column");
  assert.equal(shop.bytes, 100000);

  const totals = sumRows(bySite);
  assert.equal(totals.bytes, 1100000);
  assert.equal(formatBytes(totals.bytes), "1.0 MB");

  // Grouping by serving host separates the CDN from the document host.
  const byHost = aggregate(days, { groupBy: "host" });
  assert.equal(byHost.find((r) => r.key === "cdn.assets.net").bytes, 500000);
  assert.equal(byHost.find((r) => r.key === "ads.tracker.io").unknown, 1);

  // Date filter that excludes the day yields nothing.
  const other = await store.getDays(dateRange("2026-03-11", "2026-03-12"));
  assert.deepEqual(aggregate(other, { groupBy: "site" }), []);
});

test("flushes are idempotent across a simulated restart", async () => {
  const area = new FakeArea();
  const store = new Store(area);

  const c1 = new Collector({ store, getSettings: () => store.getSettings() });
  await c1.init();
  c1.handleCompleted(req({ responseHeaders: [{ name: "Content-Length", value: "1000" }] }));
  await c1.flush();

  // Simulate the event page being unloaded and reloaded.
  const c2 = new Collector({ store, getSettings: () => store.getSettings() });
  await c2.init();
  c2.handleCompleted(req({ responseHeaders: [{ name: "Content-Length", value: "2000" }] }));
  await c2.flush();

  const day = await store.getDay("2026-03-10");
  assert.equal(day["news.example"].b, 3000);
  assert.equal(day["news.example"].r, 2);
});

test("precise mode makes a streamed SSE response visible end to end", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  // An SSE endpoint: chunked, so no Content-Length, and onCompleted sees it as
  // an unknown-size response. Without precise mode its bytes are invisible.
  const sse = {
    type: "xmlhttprequest",
    timeStamp: DAY,
    fromCache: false,
    documentUrl: "https://www.news.example/",
    url: "https://stream.news.example/live",
    responseHeaders: [],
  };
  collector.handleCompleted(sse);
  await collector.flush();

  let days = await store.getDays(dateRange("2026-03-10", "2026-03-10"));
  let row = aggregate(days, { groupBy: "site" }).find((r) => r.key === "news.example");
  assert.equal(row.bytes, 0, "no wire bytes are known");
  assert.equal(row.unknown, 1);
  assert.equal(row.decoded, 0, "nothing measured yet");

  // Precise mode attaches a filter; chunks arrive over the life of the stream
  // and the tracker reports the total when the stream ends.
  const { StreamTracker } = await import("../src/lib/streams.js");
  let filter;
  const tracker = new StreamTracker({
    createFilter: () => (filter = {
      ondata: null, onstop: null, onerror: null,
      write() {}, close() {}, disconnect() {},
    }),
    onMeasure: (meta, bytes) => collector.handleMeasured(meta, bytes),
  });
  tracker.attach("req-1", { site: "news.example", host: "stream.news.example", timeStamp: DAY });

  filter.ondata({ data: new Uint8Array(1200) });
  filter.ondata({ data: new Uint8Array(800) });
  filter.onstop();
  await collector.flush();

  days = await store.getDays(dateRange("2026-03-10", "2026-03-10"));
  row = aggregate(days, { groupBy: "site" }).find((r) => r.key === "news.example");
  assert.equal(row.decoded, 2000, "decoded bytes are now recorded");
  assert.equal(row.measured, 1, "one measured response");
  assert.equal(row.requests, 1, "the request is still counted only once");
  assert.equal(row.unknown, 1, "and still unknown size on the wire");

  // Both numbers are available at once, which is the point of logging both.
  const totals = sumRows(aggregate(days, { groupBy: "site" }));
  assert.equal(totals.decoded, 2000);
  assert.equal(totals.bytes, 0);
});

test("a cancelled download is visible as errored rather than silently missing", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  // A large download the user cancelled: it transferred real bytes, but there is
  // no onCompleted and no Content-Length, so without onErrorOccurred it would be
  // completely invisible.
  collector.handleErrored({
    type: "xmlhttprequest",
    timeStamp: DAY,
    fromCache: false,
    documentUrl: "https://www.news.example/",
    url: "https://cdn.assets.net/movie.mp4",
    error: "NS_ERROR_ABORT",
  });
  await collector.flush();

  const days = await store.getDays(dateRange("2026-03-10", "2026-03-10"));
  const row = aggregate(days, { groupBy: "site" }).find((r) => r.key === "news.example");
  assert.equal(row.requests, 1, "the request is counted");
  assert.equal(row.errored, 1, "and flagged as errored");
  assert.equal(row.bytes, 0, "with no bytes we can attribute");
  // Errored requests are blind spots, so they must not inflate known-size coverage.
  assert.equal(coverage(sumRows([row])), 0, "no known-size responses at all");

  // The failure cause is visible without any per-request log.
  assert.deepEqual(errorReasons([row]), [{ reason: "NS_ERROR_ABORT", count: 1 }]);
});

test("the detailed log lets wire and decoded usage be compared per request", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await store.setSettings({ requestLog: true });
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  // A normal response with a Content-Length.
  collector.handleCompleted(req({ type: "image", url: "https://cdn.assets.net/hero.jpg", requestId: "r1", responseHeaders: [{ name: "Content-Length", value: "500000" }] }));
  // A chunked SSE response: no Content-Length, measured only by precise mode.
  collector.handleCompleted(req({ type: "xmlhttprequest", url: "https://stream.news.example/live", requestId: "r2", responseHeaders: [] }));
  collector.handleMeasured({ requestId: "r2", site: "news.example", host: "stream.news.example", timeStamp: DAY }, 2000);
  // A request that failed, with a reason.
  collector.handleErrored(req({ type: "xmlhttprequest", url: "https://ads.tracker.io/pixel", requestId: "r3", error: "NS_ERROR_NET_TIMEOUT" }));
  await collector.flush();

  const entries = (await store.getLogs(dateRange("2026-03-10", "2026-03-10")))[0].entries;
  assert.equal(entries.length, 3, "one row per request/error, none for the measurement");

  const image = entries.find((e) => e.host === "cdn.assets.net");
  assert.equal(image.b, 500000);
  assert.equal(image.d, null, "nothing decoded was measured for this one");

  const sse = entries.find((e) => e.host === "stream.news.example");
  assert.equal(sse.b, null, "no wire size known");
  assert.equal(sse.d, 2000, "decoded bytes land on the same row");

  const failed = entries.find((e) => e.host === "ads.tracker.io");
  assert.equal(failed.e, "NS_ERROR_NET_TIMEOUT");

  // The CSV export carries both byte columns and the error reason.
  const csv = entriesToCsv(entries);
  assert.ok(csv.startsWith("time,site,host,type,wire_bytes,cached_bytes,decoded_bytes,cached,error"));
  assert.ok(csv.includes("NS_ERROR_NET_TIMEOUT"));
});

