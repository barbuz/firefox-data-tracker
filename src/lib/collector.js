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

  /**
   * Called on webRequest.onErrorOccurred. A request that failed part-way may
   * still have transferred bytes that we can never see (there is no
   * Content-Length and no onCompleted), so it is recorded as a request and as
   * errored rather than being dropped. This is what keeps cancelled or failed
   * large downloads from silently vanishing from the totals.
   */
  handleErrored(details) {
    if (details.type === "speculative") return;

    const site = siteKeyForRequest(details);
    if (!site) return;

    const date = dateKey(details.timeStamp || Date.now());
    const day = (this.buffer[date] ||= {});
    accumulate(day, {
      site,
      host: servingHostForRequest(details),
      bytes: null,
      fromCache: false,
      errored: true,
    });
    this.requestFlush();
  }

  /**
   * Called by the StreamTracker when precise mode wanted to measure a response
   * but could not (the filter could not be attached, or was torn down before
   * any bytes arrived). Counted so a silently failing precise mode is visible
   * instead of just under-reporting.
   */
  handleSkipped(meta) {
    if (!meta?.site) return;
    const date = dateKey(meta.timeStamp || Date.now());
    const day = (this.buffer[date] ||= {});
    accumulate(day, {
      site: meta.site,
      host: meta.host,
      bytes: null,
      fromCache: false,
      unmeasured: true,
      countRequest: false,
      wireAccounting: false,
    });
    this.requestFlush();
  }

  /**
   * Called by the StreamTracker once a filtered response has fully arrived.
   *
   * This is a *second* event for a request already seen on onCompleted, so it
   * counts no request and touches no wire counter: it only records the decoded
   * byte total. Those bytes are what make chunked/streamed responses (SSE,
   * fetch streams) visible at all, since they carry no Content-Length.
   *
   * @param {{site:string, host:string, timeStamp:number}} meta
   * @param {number} decodedBytes
   */
  handleMeasured(meta, decodedBytes) {
    if (!meta?.site) return;
    const date = dateKey(meta.timeStamp || Date.now());
    const day = (this.buffer[date] ||= {});
    accumulate(day, {
      site: meta.site,
      host: meta.host,
      bytes: null,
      fromCache: false,
      decoded: decodedBytes,
      measured: true,
      countRequest: false,
      wireAccounting: false,
    });
    this.requestFlush();
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
