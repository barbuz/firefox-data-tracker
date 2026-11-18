// Storage layer. Wraps the extension storage area so the collector can be
// tested with an in-memory fake, and so all key naming lives in one place.

import { mergeDay } from "./aggregate.js";

export const DAY_PREFIX = "day:";
export const LOG_PREFIX = "log:";
export const SETTINGS_KEY = "settings";

// Hard cap on log rows kept per day. The per-request log is the only unbounded
// structure, so it is bounded here: once a day reaches the cap, further rows are
// dropped (the aggregate buckets are unaffected). 5000 rows/day keeps a heavy
// session's log to a few hundred KB while still covering a normal day.
export const MAX_LOG_ENTRIES_PER_DAY = 5000;

export const DEFAULT_SETTINGS = {
  retentionDays: 90,   // 0 = keep forever
  // Opt-in exact counting via filterResponseData. Requires the optional
  // webRequestBlocking + webRequestFilterResponse permissions and makes the
  // extension block on every response, so it stays off by default.
  preciseMode: false,
  // Opt-in per-request / per-error log, so wire and decoded usage can be compared
  // request by request and failure causes inspected. Off by default: unlike the
  // aggregate buckets this grows with request volume (bounded per day above).
  requestLog: false,
};

export function dayKeyName(date) {
  return DAY_PREFIX + date;
}

export function logKeyName(date) {
  return LOG_PREFIX + date;
}

export class Store {
  /**
   * @param {object} area  a browser.storage.StorageArea-compatible object
   */
  constructor(area) {
    this.area = area;
  }

  async getSettings() {
    const res = await this.area.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
  }

  async setSettings(patch) {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    await this.area.set({ [SETTINGS_KEY]: next });
    return next;
  }

  /** Read the raw day bucket for a date, or {} when absent. */
  async getDay(date) {
    const res = await this.area.get(dayKeyName(date));
    return res[dayKeyName(date)] || {};
  }

  /** Merge a buffer of day buckets into storage (read-modify-write per day). */
  async mergeDays(buffers) {
    const dates = Object.keys(buffers);
    if (dates.length === 0) return;
    const keys = dates.map(dayKeyName);
    const existing = await this.area.get(keys);
    const updates = {};
    for (const date of dates) {
      const stored = existing[dayKeyName(date)] || {};
      updates[dayKeyName(date)] = mergeDay(stored, buffers[date]);
    }
    await this.area.set(updates);
  }

  /** Load day buckets for a list of dates, skipping empty ones. */
  async getDays(dates) {
    if (dates.length === 0) return [];
    const keys = dates.map(dayKeyName);
    const res = await this.area.get(keys);
    const out = [];
    for (const date of dates) {
      const data = res[dayKeyName(date)];
      if (data) out.push({ date, data });
    }
    return out;
  }

  /** List all dates that currently have data, ascending. */
  async listDates() {
    const all = await this.area.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(DAY_PREFIX))
      .map((k) => k.slice(DAY_PREFIX.length))
      .sort();
  }

  /**
   * Every date that has either a day bucket or a log, ascending. Used by prune
   * and clearAll so a log cannot be orphaned by a missing bucket (or vice versa).
   */
  async listAllDates() {
    const all = await this.area.get(null);
    const dates = new Set();
    for (const k of Object.keys(all)) {
      if (k.startsWith(DAY_PREFIX)) dates.add(k.slice(DAY_PREFIX.length));
      else if (k.startsWith(LOG_PREFIX)) dates.add(k.slice(LOG_PREFIX.length));
    }
    return [...dates].sort();
  }

  /** Read the raw log array for a date, or [] when absent. */
  async getLog(date) {
    const res = await this.area.get(logKeyName(date));
    return res[logKeyName(date)] || [];
  }

  /**
   * Append per-request log rows to storage, one key per day. Each day's array is
   * capped at MAX_LOG_ENTRIES_PER_DAY: once full, further rows are dropped so a
   * pathological session cannot grow storage without bound. Dropping rows never
   * affects the aggregate buckets, which are counted separately.
   *
   * @param {Object<string, Array<object>>} buffers  { "YYYY-MM-DD": [entry, ...] }
   */
  async appendLogs(buffers) {
    const dates = Object.keys(buffers);
    if (dates.length === 0) return;
    const keys = dates.map(logKeyName);
    const existing = await this.area.get(keys);
    const updates = {};
    for (const date of dates) {
      const key = logKeyName(date);
      const stored = existing[key] || [];
      const room = MAX_LOG_ENTRIES_PER_DAY - stored.length;
      if (room <= 0) continue;
      const add = room >= buffers[date].length ? buffers[date] : buffers[date].slice(0, room);
      updates[key] = stored.concat(add);
    }
    if (Object.keys(updates).length) await this.area.set(updates);
  }

  /** Load log rows for a list of dates, skipping empty ones. */
  async getLogs(dates) {
    if (dates.length === 0) return [];
    const keys = dates.map(logKeyName);
    const res = await this.area.get(keys);
    const out = [];
    for (const date of dates) {
      const entries = res[logKeyName(date)];
      if (entries && entries.length) out.push({ date, entries });
    }
    return out;
  }

  /** Delete day buckets older than the retention window. Returns count removed. */
  async prune(retentionDays) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
    const dates = await this.listAllDates();
    const stale = dates.filter((d) => d < cutoffKey);
    if (stale.length) {
      // Remove the log for a pruned day alongside its bucket, so the opt-in log
      // cannot outlive the retention window it belongs to.
      const keys = stale.flatMap((d) => [dayKeyName(d), logKeyName(d)]);
      await this.area.remove(keys);
    }
    return stale.length;
  }

  /** Remove every day bucket and log, keeping settings. */
  async clearAll() {
    const dates = await this.listAllDates();
    if (dates.length) {
      const keys = dates.flatMap((d) => [dayKeyName(d), logKeyName(d)]);
      await this.area.remove(keys);
    }
    return dates.length;
  }
}
