import { test } from "node:test";
import assert from "node:assert/strict";

import { Store, dayKeyName, logKeyName, MAX_LOG_ENTRIES_PER_DAY, DEFAULT_SETTINGS } from "../src/lib/store.js";
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
  assert.equal(next.preciseMode, DEFAULT_SETTINGS.preciseMode);
  assert.equal(next.requestLog, false, "the detailed log is off by default");
});

test("appendLogs appends rows per day and getLog reads them back", async () => {
  const store = new Store(new FakeArea());
  await store.appendLogs({ "2026-01-05": [{ t: 1, site: "a.com" }] });
  await store.appendLogs({ "2026-01-05": [{ t: 2, site: "b.com" }] });

  const log = await store.getLog("2026-01-05");
  assert.deepEqual(log.map((e) => e.t), [1, 2]);
  assert.deepEqual(await store.getLog("2026-01-06"), [], "a day with no log reads as empty");
});

test("appendLogs caps a day at MAX_LOG_ENTRIES_PER_DAY", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  const big = Array.from({ length: MAX_LOG_ENTRIES_PER_DAY }, (_, i) => ({ t: i }));
  await store.appendLogs({ "2026-01-05": big });
  // The cap is already reached, so an extra batch adds nothing.
  await store.appendLogs({ "2026-01-05": [{ t: "overflow" }] });

  const log = await store.getLog("2026-01-05");
  assert.equal(log.length, MAX_LOG_ENTRIES_PER_DAY);
  assert.equal(log[log.length - 1].t, MAX_LOG_ENTRIES_PER_DAY - 1);
});

test("getLogs returns only days that have rows", async () => {
  const store = new Store(new FakeArea());
  await store.appendLogs({ "2026-01-05": [{ t: 1 }] });
  const days = await store.getLogs(["2026-01-04", "2026-01-05", "2026-01-06"]);
  assert.deepEqual(days, [{ date: "2026-01-05", entries: [{ t: 1 }] }]);
});

test("prune and clearAll remove log rows alongside day buckets", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await store.mergeDays({ "2000-01-01": { "old.com": { b: 1, r: 1, u: 0, c: 0, h: {} } } });
  await store.appendLogs({ "2000-01-01": [{ t: 1 }], "2999-01-01": [{ t: 2 }] });

  await store.prune(30);
  assert.deepEqual(await store.getLog("2000-01-01"), [], "pruned day loses its log too");
  assert.deepEqual((await store.getLog("2999-01-01")).map((e) => e.t), [2], "recent log is kept");

  await store.clearAll();
  assert.deepEqual(await store.getLog("2999-01-01"), []);
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
  assert.equal(day["example.com"].cb, 2048, "cached bytes saved in their own field");
  assert.equal(day["example.com"].b, 0, "no network bytes counted for the cache hit");
  assert.equal(day["example.com"].r, 2, "speculative request ignored");
});

test("collector counts failed requests instead of dropping them", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleErrored(completed({ responseHeaders: [], url: "https://cdn.example.net/big.iso" }));
  collector.handleErrored(completed({ type: "speculative" }));

  const day = collector.buffer["2026-01-05"];
  assert.equal(day["example.com"].r, 1, "the failed request is still counted");
  assert.equal(day["example.com"].e, 1, "and flagged as errored");
  assert.equal(day["example.com"].b, 0);
  assert.equal(day["example.com"].h["cdn.example.net"].e, 1);
});

test("collector records the error reason so the cause is visible", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleErrored(completed({ responseHeaders: [], error: "NS_ERROR_NET_TIMEOUT" }));
  collector.handleErrored(completed({ responseHeaders: [], error: "NS_ERROR_NET_TIMEOUT" }));

  const day = collector.buffer["2026-01-05"];
  assert.deepEqual(day["example.com"].er, { NS_ERROR_NET_TIMEOUT: 2 });
});

test("no per-request log rows are buffered while the log is off", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleCompleted(completed());
  collector.handleErrored(completed({ responseHeaders: [] }));

  assert.equal(collector.bufferedLogRows, 0, "the default path stores aggregates only");
  await collector.flush();
  assert.deepEqual(await store.getLog("2026-01-05"), []);
});

test("the request log records one row per request and per error when enabled", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await store.setSettings({ requestLog: true });
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleCompleted(completed({ requestId: "r1" }));
  collector.handleCompleted(completed({ responseHeaders: [], requestId: "r2" }));
  collector.handleErrored(completed({ responseHeaders: [], requestId: "r3", error: "NS_ERROR_ABORT" }));
  await collector.flush();

  const log = await store.getLog("2026-01-05");
  assert.equal(log.length, 3);
  assert.equal(log[0].b, 2048, "completed request keeps its Content-Length");
  assert.equal(log[1].b, null, "a response with no Content-Length is logged as unknown");
  assert.equal(log[2].e, "NS_ERROR_ABORT", "the failed request carries its reason");
  assert.equal(log[2].b, null);
});

test("a precise-mode measurement fills the decoded bytes into the same log row", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await store.setSettings({ requestLog: true });
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  // onCompleted sees a chunked response with no Content-Length, then precise mode
  // measures it; both must land on one row so wire and decoded can be compared.
  collector.handleCompleted(completed({ responseHeaders: [], requestId: "r1" }));
  collector.handleMeasured({ requestId: "r1", site: "example.com", host: "cdn.example.net", timeStamp: completed().timeStamp }, 4096);
  await collector.flush();

  const log = await store.getLog("2026-01-05");
  assert.equal(log.length, 1, "the measurement is not a second row");
  assert.equal(log[0].b, null, "no wire size was known");
  assert.equal(log[0].d, 4096, "the decoded total is on the same row");
});

test("the log is capped per day even across flushes", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await store.setSettings({ requestLog: true });
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  for (let i = 0; i < MAX_LOG_ENTRIES_PER_DAY + 50; i++) {
    collector.handleCompleted(completed({ requestId: `r${i}` }));
  }
  await collector.flush();

  assert.equal((await store.getLog("2026-01-05")).length, MAX_LOG_ENTRIES_PER_DAY);
});

test("collector records a precise-mode measurement gap without double-counting", async () => {
  const store = new Store(new FakeArea());
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  // The request itself, which onCompleted already counted as unknown size.
  collector.handleCompleted(completed({ responseHeaders: [] }));
  // Precise mode wanted to measure it but could not attach a filter.
  collector.handleSkipped({ site: "example.com", host: "cdn.example.net", timeStamp: completed().timeStamp });

  const day = collector.buffer["2026-01-05"];
  assert.equal(day["example.com"].r, 1, "request counted once");
  assert.equal(day["example.com"].u, 1, "still unknown size");
  assert.equal(day["example.com"].x, 1, "measurement gap recorded");
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

test("a failed log append is retried without double-counting the day bucket", async () => {
  const area = new FakeArea();
  const store = new Store(area);
  await store.setSettings({ requestLog: true });
  let failNext = true;
  const origAppend = store.appendLogs.bind(store);
  store.appendLogs = async (buf) => {
    if (failNext) { failNext = false; throw new Error("disk full"); }
    return origAppend(buf);
  };
  const collector = new Collector({ store, getSettings: () => store.getSettings() });
  await collector.init();

  collector.handleCompleted(completed({ requestId: "r1" }));
  await assert.rejects(() => collector.flush());
  assert.equal(collector.bufferedLogRows, 1, "log rows retained after failure");
  assert.equal(collector.bufferedDays, 0, "the day merge already succeeded");

  await collector.flush();
  // The day bucket was written once and must not be counted again on retry.
  assert.equal((await store.getDay("2026-01-05"))["example.com"].b, 2048);
  assert.equal((await store.getLog("2026-01-05")).length, 1);
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
