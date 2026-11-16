import { test } from "node:test";
import assert from "node:assert/strict";

import { Store, dayKeyName, DEFAULT_SETTINGS } from "../src/lib/store.js";
import { Collector } from "../src/lib/collector.js";

// Minimal in-memory implementation of a storage area, matching the subset of
// browser.storage.StorageArea that Store uses. Real code paths are exercised;
// only the browser's persistence layer is replaced.
class FakeArea {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }
  async get(keys) {
    if (keys === null || keys === undefined) return structuredClone(this.data);
    if (typeof keys === "string") {
      return keys in this.data ? { [keys]: structuredClone(this.data[keys]) } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
      return out;
    }
    const out = {};
    for (const k of Object.keys(keys)) {
      out[k] = k in this.data ? structuredClone(this.data[k]) : keys[k];
    }
    return out;
  }
  async set(items) { Object.assign(this.data, structuredClone(items)); }
  async remove(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k];
  }
}

const completed = (over = {}) => ({
  url: "https://cdn.example.net/app.js",
  documentUrl: "https://www.example.com/page",
  type: "script",
  timeStamp: new Date(2026, 0, 5, 12, 0).getTime(),
  fromCache: false,
  responseHeaders: [{ name: "Content-Length", value: "2048" }],
  ...over,
});

test("settings fall back to defaults and merge patches", async () => {
  const store = new Store(new FakeArea());
  assert.deepEqual(await store.getSettings(), DEFAULT_SETTINGS);
  const next = await store.setSettings({ retentionDays: 7 });
  assert.equal(next.retentionDays, 7);
  assert.equal(next.excludeCached, DEFAULT_SETTINGS.excludeCached);
});

test("mergeDays accumulates across multiple flushes", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  const date = "2026-01-05";

  await store.mergeDays({ [date]: { "example.com": { b: 100, r: 1, u: 0, c: 0, h: { "cdn.net": { b: 100, r: 1, u: 0, c: 0 } } } } });
  await store.mergeDays({ [date]: { "example.com": { b: 250, r: 2, u: 1, c: 0, h: { "cdn.net": { b: 250, r: 2, u: 1, c: 0 } } } } });

  const day = await store.getDay(date);
  assert.equal(day["example.com"].b, 350);
  assert.equal(day["example.com"].r, 3);
  assert.equal(day["example.com"].h["cdn.net"].b, 350);
});

test("collector buffers, debounces, and flushes to storage", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  const scheduled = [];
  const collector = new Collector({
    store,
    getSettings: () => store.getSettings(),
    schedule: (fn) => scheduled.push(fn),
  });
  await collector.init();

  collector.handleCompleted(completed());
  collector.handleCompleted(completed({ url: "https://example.com/", documentUrl: undefined, type: "main_frame", responseHeaders: [{ name: "Content-Length", value: "1000" }] }));

  assert.equal(scheduled.length, 1, "flush is debounced to a single schedule");
  assert.equal(collector.bufferedDays, 1);

  await collector.flush();
  assert.equal(collector.bufferedDays, 0);

  const day = await store.getDay("2026-01-05");
  assert.equal(day["example.com"].b, 3048);
  assert.equal(day["example.com"].r, 2);
  assert.equal(day["example.com"].h["cdn.example.net"].b, 2048);
});

test("collector counts unknown-size and cached responses", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleCompleted(completed({ responseHeaders: [] }));
  collector.handleCompleted(completed({ fromCache: true }));
  collector.handleCompleted(completed({ type: "speculative" }));

  const day = collector.buffer["2026-01-05"];
  assert.equal(day["example.com"].u, 1, "no content-length -> unknown");
  assert.equal(day["example.com"].c, 1, "cached response counted separately");
  assert.equal(day["example.com"].b, 0, "no bytes counted");
  assert.equal(day["example.com"].r, 2, "speculative request ignored");
});

test("collector retries a failed flush instead of dropping data", async () => {
  const store = new Store(new FakeArea());
  let failNext = true;
  const origMerge = store.mergeDays.bind(store);
  store.mergeDays = async (buf) => {
    if (failNext) { failNext = false; throw new Error("disk full"); }
    return origMerge(buf);
  };
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleCompleted(completed());
  await assert.rejects(() => collector.flush());
  assert.equal(collector.bufferedDays, 1, "data retained after failure");

  await collector.flush();
  const day = await store.getDay("2026-01-05");
  assert.equal(day["example.com"].b, 2048);
});

test("prune removes days older than the retention window", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await area.set({
    [dayKeyName("2000-01-01")]: { "old.com": { b: 1, r: 1, u: 0, c: 0, h: {} } },
    [dayKeyName("2999-01-01")]: { "new.com": { b: 1, r: 1, u: 0, c: 0, h: {} } },
  });

  const removed = await store.prune(30);
  assert.equal(removed, 1);
  assert.deepEqual(await store.listDates(), ["2999-01-01"]);
});

test("clearAll removes day buckets but keeps settings", async () => {
  const store = new Store(new FakeArea());
  await store.setSettings({ retentionDays: 5 });
  await store.mergeDays({ "2026-01-05": { "a.com": { b: 1, r: 1, u: 0, c: 0, h: {} } } });

  await store.clearAll();
  assert.deepEqual(await store.listDates(), []);
  assert.equal((await store.getSettings()).retentionDays, 5);
});
