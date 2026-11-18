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
import { completedEntry, erroredEntry, addDecoded } from "./requestlog.js";

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
    this.logBuffer = {};     // { "YYYY-MM-DD": [entry, ...] } (requestLog only)
    this.logIndex = new Map(); // requestId -> entry, to fold a later decoded total
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
    const fromCache = !!details.fromCache;

    const site = siteKeyForRequest(details);
    const host = servingHostForRequest(details);
    if (!site) return;

    const date = dateKey(details.timeStamp || Date.now());
    const day = (this.buffer[date] ||= {});
    accumulate(day, { site, host, bytes, fromCache });
    this.recordLog(date, details, { site, host, bytes });
    this.requestFlush();
  }

  /**
   * Buffer a per-request log row, when the opt-in log is enabled. The row keeps a
   * reference keyed by requestId so a precise-mode measurement arriving later can
   * fill in the decoded byte total for the same request.
   */
  recordLog(date, details, { site, host, bytes }) {
    if (!this.settings?.requestLog) return;
    const entry = completedEntry({
      timeStamp: details.timeStamp || Date.now(),
      site,
      host,
      type: details.type,
      bytes,
      fromCache: !!details.fromCache,
    });
    (this.logBuffer[date] ||= []).push(entry);
    if (details.requestId) this.logIndex.set(details.requestId, entry);
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
    const host = servingHostForRequest(details);
    const reason = errorReason(details);
    accumulate(day, {
      site,
      host,
      bytes: null,
      fromCache: false,
      errored: true,
      errorReason: reason,
    });
    if (this.settings?.requestLog) {
      (this.logBuffer[date] ||= []).push(
        erroredEntry({
          timeStamp: details.timeStamp || Date.now(),
          site,
          host,
          type: details.type,
          reason,
        })
      );
    }
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
    // Fold the decoded total into the same request's log row, so the log can be
    // used to compare wire vs decoded usage request by request.
    const entry = meta.requestId && this.logIndex.get(meta.requestId);
    if (entry) addDecoded(entry, decodedBytes);
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
    const daySnapshot = this.buffer;
    const logSnapshot = this.logBuffer;
    this.buffer = {};
    this.logBuffer = {};
    // Decoded totals are folded into log rows that have now been written; drop the
    // index so it cannot grow across flushes. A measurement arriving for an
    // already-flushed request is simply not reflected in that log row (the
    // aggregate decoded column still records it).
    this.logIndex.clear();

    const hasDays = Object.keys(daySnapshot).length > 0;
    const hasLog = Object.keys(logSnapshot).length > 0;
    if (!hasDays && !hasLog) return;

    // Each buffer is restored independently on failure: if the day merge succeeds
    // but the log append fails, restoring the days too would double-count them on
    // the next flush.
    try {
      if (hasDays) await this.store.mergeDays(daySnapshot);
    } catch (err) {
      for (const [date, day] of Object.entries(daySnapshot)) {
        this.buffer[date] = mergeDay(this.buffer[date], day);
      }
      throw err;
    }
    try {
      if (hasLog) await this.store.appendLogs(logSnapshot);
    } catch (err) {
      for (const [date, entries] of Object.entries(logSnapshot)) {
        this.logBuffer[date] = (this.logBuffer[date] || []).concat(entries);
      }
      throw err;
    }
  }

  /** Test/teardown helper. */
  get bufferedDays() {
    return Object.keys(this.buffer).length;
  }

  /** Test/teardown helper. */
  get bufferedLogRows() {
    return Object.values(this.logBuffer).reduce((n, rows) => n + rows.length, 0);
  }
}

/** Map webRequest.onErrorOccurred details to a short, stable reason label. */
function errorReason(details) {
  return details?.error || "unknown";
}
