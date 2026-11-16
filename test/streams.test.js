// Tests for the precise-mode stream tracker. The browser is faked at the
// StreamFilter boundary only: createFilter() returns a plain object whose event
// handlers the test drives directly, so all tracker logic is the real code.

import { test } from "node:test";
import assert from "node:assert/strict";

import { StreamTracker } from "../src/lib/streams.js";
import { accumulate } from "../src/lib/aggregate.js";

// A StreamFilter stand-in that records everything the tracker does to it.
function fakeFilter() {
  return {
    ondata: null,
    onstop: null,
    onerror: null,
    written: [],
    closed: false,
    disconnected: false,
    write(chunk) { this.written.push(chunk); },
    close() { this.closed = true; },
    disconnect() { this.disconnected = true; },
  };
}

function harness(over = {}) {
  const filters = [];
  const measures = [];
  const tracker = new StreamTracker({
    createFilter: () => {
      const f = fakeFilter();
      filters.push(f);
      return f;
    },
    onMeasure: (meta, bytes) => measures.push({ meta, bytes }),
    ...over,
  });
  return { tracker, filters, measures };
}

const META = { site: "example.com", host: "cdn.example.com", timeStamp: 0 };

test("attach passes bytes through untouched and sums their length", () => {
  const { tracker, filters, measures } = harness();
  assert.equal(tracker.attach("r1", META), true);

  const f = filters[0];
  f.ondata({ data: new Uint8Array(10) });
  f.ondata({ data: new Uint8Array(25) });
  f.onstop();

  assert.deepEqual(measures, [{ meta: META, bytes: 35 }]);
  // Every chunk must be written back, or the response is truncated.
  assert.equal(f.written.length, 2);
  assert.equal(f.closed, true);
});

test("attach refuses duplicates and missing ids", () => {
  const { tracker } = harness();
  assert.equal(tracker.attach("r1", META), true);
  assert.equal(tracker.attach("r1", META), false, "duplicate requestId");
  assert.equal(tracker.attach("", META), false, "missing requestId");
  assert.equal(tracker.attach("r2", { site: "" }), false, "missing site");
});

test("a filter that throws is reported as not attached", () => {
  const tracker = new StreamTracker({
    createFilter: () => { throw new Error("no such request"); },
    onMeasure: () => {},
  });
  assert.equal(tracker.attach("r1", META), false);
  assert.equal(tracker.openCount, 0);
});

test("a response that delivers no bytes is not recorded", () => {
  const { tracker, filters, measures } = harness();
  tracker.attach("r1", META);
  filters[0].onstop(); // e.g. a cached or 204 response
  assert.deepEqual(measures, []);
  assert.equal(filters[0].closed, true, "stream is still released");
});

test("onerror keeps the bytes measured before the failure", () => {
  const { tracker, filters, measures } = harness();
  tracker.attach("r1", META);
  filters[0].ondata({ data: new Uint8Array(64) });
  filters[0].onerror();

  assert.deepEqual(measures, [{ meta: META, bytes: 64 }]);
  assert.equal(tracker.openCount, 0);
});

test("onstop only records once even if it fires twice", () => {
  const { tracker, filters, measures } = harness();
  tracker.attach("r1", META);
  filters[0].ondata({ data: new Uint8Array(5) });
  filters[0].onstop();
  filters[0].onstop();
  assert.equal(measures.length, 1);
});

test("stopAll disconnects open filters and keeps partial totals", () => {
  const { tracker, filters, measures } = harness();
  tracker.attach("r1", META);
  tracker.attach("r2", { ...META, site: "other.com" });
  filters[0].ondata({ data: new Uint8Array(7) });
  filters[1].ondata({ data: new Uint8Array(3) });

  tracker.stopAll();

  assert.equal(tracker.openCount, 0);
  assert.equal(measures.length, 2);
  // disconnect (not close) so the browser can finish serving the response.
  assert.equal(filters[0].disconnected, true);
  assert.equal(filters[0].closed, false);
  assert.equal(measures.find((m) => m.meta.site === "example.com").bytes, 7);
});

test("open filters are capped so a lost onstop cannot leak", () => {
  const { tracker, filters } = harness({ maxPending: 2 });
  tracker.attach("r1", META);
  tracker.attach("r2", META);
  tracker.attach("r3", META); // evicts r1

  assert.equal(tracker.openCount, 2);
  assert.equal(filters[0].disconnected, true);
});

test("a measurement folds into the day bucket without double-counting", () => {
  const day = {};
  // The wire event for the same request, which had no Content-Length.
  accumulate(day, { site: "example.com", host: "cdn.example.com", bytes: null, fromCache: false });
  // The later stream measurement for that request.
  accumulate(day, {
    site: "example.com",
    host: "cdn.example.com",
    bytes: null,
    fromCache: false,
    decoded: 4096,
    measured: true,
    countRequest: false,
    wireAccounting: false,
  });

  const s = day["example.com"];
  assert.equal(s.r, 1, "the request is counted once, not twice");
  assert.equal(s.u, 1, "still unknown size on the wire");
  assert.equal(s.d, 4096, "decoded bytes recorded");
  assert.equal(s.dm, 1, "one measured response");
  assert.equal(s.h["cdn.example.com"].d, 4096);
  assert.equal(s.h["cdn.example.com"].r, 1);
});
