// Storage layer. Wraps the extension storage area so the collector can be
// tested with an in-memory fake, and so all key naming lives in one place.

import { mergeDay } from "./aggregate.js";

export const DAY_PREFIX = "day:";
export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS = {
  retentionDays: 90,   // 0 = keep forever
  excludeCached: true, // don't count disk-cache hits toward bytes
  preciseMode: false,  // reserved: exact counting via filterResponseData
};

export function dayKeyName(date) {
  return DAY_PREFIX + date;
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

  /** Delete day buckets older than the retention window. Returns count removed. */
  async prune(retentionDays) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
    const dates = await this.listDates();
    const stale = dates.filter((d) => d < cutoffKey);
    if (stale.length) await this.area.remove(stale.map(dayKeyName));
    return stale.length;
  }

  /** Remove every day bucket, keeping settings. */
  async clearAll() {
    const dates = await this.listDates();
    if (dates.length) await this.area.remove(dates.map(dayKeyName));
    return dates.length;
  }
}
