// End-to-end smoke test: drive the real Collector -> Store -> aggregate pipeline
// with a simulated browsing session and assert the numbers a user would see.
// Only browser.storage is faked; all accounting code is the real thing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "../src/lib/store.js";
import { Collector } from "../src/lib/collector.js";
import { aggregate, dateRange, sumRows, formatBytes } from "../src/lib/aggregate.js";

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
  // unknown-size ad pixel; cached logo bytes are excluded.
  assert.equal(news.bytes, 1000000);
  assert.equal(news.requests, 5);
  assert.equal(news.unknown, 1);
  assert.equal(news.cached, 1);
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
