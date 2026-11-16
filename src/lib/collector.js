// Request collector. Turns raw webRequest details into day-bucket mutations and
// owns the debounced flush to storage. Kept free of direct browser globals so it
// can be unit-tested: the caller injects the Store and a scheduling function.

import {
  contentLengthFromHeaders,
  dateKey,
  accumulate,
  mergeDay,
} from "./aggregate.js";
import { siteKeyForRequest, servingHostForRequest } from "./domain.js";

export class Collector {
  /**
   * @param {object} deps
   * @param {import("./store.js").Store} deps.store
   * @param {() => Promise<object>} deps.getSettings
   * @param {(fn: Function, ms: number) => void} [deps.schedule]
   *        debounce scheduler; defaults to setTimeout
   */
  constructor({ store, getSettings, schedule }) {
    this.store = store;
    this.getSettings = getSettings;
    this.schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this.buffer = {};        // { "YYYY-MM-DD": dayBucket }
    this.pendingFlush = null;
    this.settings = null;
  }

  async init() {
    this.settings = await this.getSettings();
    return this;
  }

  /** Called on webRequest.onCompleted. */
  handleCompleted(details) {
    // Skip speculative connections: no real tab and no meaningful payload.
    if (details.type === "speculative") return;

    const bytes = contentLengthFromHeaders(details.responseHeaders);
    const fromCache = this.settings?.excludeCached !== false && !!details.fromCache;

    const site = siteKeyForRequest(details);
    const host = servingHostForRequest(details);
    if (!site) return;

    const date = dateKey(details.timeStamp || Date.now());
    const day = (this.buffer[date] ||= {});
    accumulate(day, { site, host, bytes, fromCache });
    this.requestFlush();
  }

  /** Update cached settings (e.g. after the user toggles a preference). */
  applySettings(settings) {
    this.settings = settings;
  }

  requestFlush() {
    if (this.pendingFlush) return;
    this.pendingFlush = this.schedule(() => {
      this.pendingFlush = null;
      this.flush().catch(() => {});
    }, 3000);
  }

  /** Merge the in-memory buffer into storage. Safe to call directly on shutdown. */
  async flush() {
    if (Object.keys(this.buffer).length === 0) return;
    const snapshot = this.buffer;
    this.buffer = {};
    try {
      await this.store.mergeDays(snapshot);
    } catch (err) {
      // Put the data back so a later flush can retry.
      for (const [date, day] of Object.entries(snapshot)) {
        this.buffer[date] = mergeDay(this.buffer[date], day);
      }
      throw err;
    }
  }

  /** Test/teardown helper. */
  get bufferedDays() {
    return Object.keys(this.buffer).length;
  }
}
