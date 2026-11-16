// Precise-mode byte measurement via webRequest.filterResponseData().
//
// A StreamFilter sits between the network and the rendering engine and sees the
// response body *after* content conversion, i.e. decompressed. That is a
// different unit from Content-Length (compressed wire bytes), which is why the
// collector stores both and the UI labels them separately.
//
// Two rules keep this from breaking pages:
//   1. Every chunk handed to us must be written back unchanged, or the response
//      is truncated.
//   2. The filter must always be closed/disconnected. A filter left open holds
//      the response open forever, so a leaked filter is a hung page load.
//
// Kept free of browser globals so it can be unit-tested: the caller injects a
// createFilter(requestId) function.

export class StreamTracker {
  /**
   * @param {object} deps
   * @param {(requestId: string) => object} deps.createFilter
   *        returns a StreamFilter-like object; usually
   *        (id) => browser.webRequest.filterResponseData(id)
   * @param {(meta: object, decodedBytes: number) => void} deps.onMeasure
   *        called once per attached response, with the decoded byte total
   * @param {number} [deps.maxPending]  cap on simultaneously open filters
   */
  constructor({ createFilter, onMeasure, maxPending = 500 }) {
    this.createFilter = createFilter;
    this.onMeasure = onMeasure;
    this.maxPending = maxPending;
    this.pending = new Map();
  }

  /**
   * Attach a measuring filter to a response. Returns false when no filter could
   * be created (no requestId, duplicate attach, or the API threw).
   *
   * @param {string} requestId
   * @param {{site: string, host: string, timeStamp: number}} meta
   */
  attach(requestId, meta) {
    if (!requestId || !meta?.site || this.pending.has(requestId)) return false;

    let filter;
    try {
      filter = this.createFilter(requestId);
    } catch {
      return false;
    }
    if (!filter) return false;

    const state = { meta, bytes: 0, done: false, filter };
    this.pending.set(requestId, state);
    this.evictOverflow();

    filter.ondata = (event) => {
      const chunk = event?.data;
      if (chunk && typeof chunk.byteLength === "number") state.bytes += chunk.byteLength;
      // Pass through untouched; swallowing the chunk would truncate the body.
      if (chunk) {
        try {
          filter.write(chunk);
        } catch {
          // Filter already torn down; nothing more we can do with this chunk.
        }
      }
    };

    filter.onstop = () => {
      // A response that delivered no bytes (cached, 204, aborted early) has
      // nothing to report; recording it would inflate the measured count.
      this.finish(requestId, state, state.bytes > 0);
      try {
        filter.close();
      } catch {
        // Already closed or errored.
      }
    };

    filter.onerror = () => {
      // The stream is already gone; keep whatever we measured before the error.
      this.finish(requestId, state, state.bytes > 0);
    };

    return true;
  }

  /**
   * Record a completed measurement and forget the response. `record` is false
   * when there is nothing worth storing (e.g. a filter that errored before any
   * data arrived).
   */
  finish(requestId, state, record = true) {
    if (state.done) return;
    state.done = true;
    this.pending.delete(requestId);
    if (record) {
      try {
        this.onMeasure(state.meta, state.bytes);
      } catch {
        // Never let a bookkeeping error surface into the filter's event loop.
      }
    }
  }

  /** Cap open filters so a lost onstop cannot grow memory without bound. */
  evictOverflow() {
    while (this.pending.size > this.maxPending) {
      const [id, state] = this.pending.entries().next().value;
      // disconnect() lets the browser keep serving the response normally while
      // we stop measuring; close() here would truncate it instead.
      try {
        state.filter?.disconnect?.();
      } catch {
        // Ignore: the filter may already be gone.
      }
      this.finish(id, state, state.bytes > 0);
    }
  }

  /** Detach every open filter (used when precise mode is switched off or the
   * event page is going away). Keeps whatever was measured so far. */
  stopAll() {
    for (const [id, state] of [...this.pending]) {
      try {
        state.filter?.disconnect?.();
      } catch {
        // Ignore.
      }
      this.finish(id, state, state.bytes > 0);
    }
  }

  get openCount() {
    return this.pending.size;
  }
}
