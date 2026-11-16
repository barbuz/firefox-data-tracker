// Dashboard: loads aggregated day buckets from storage, applies the date-range
// and site filters, and renders the results table. All data stays local.

import { Store } from "../lib/store.js";
import {
  aggregate,
  dateRange,
  dateKey,
  formatBytes,
  sumRows,
  rowsToCsv,
  coverage,
} from "../lib/aggregate.js";

const store = new Store(browser.storage.local);
const $ = (id) => document.getElementById(id);

// Optional permissions precise mode needs. Requested from the toggle's click
// handler, because Firefox requires a user gesture for permissions.request().
const PRECISE_PERMISSIONS = { permissions: ["webRequestBlocking", "webRequestFilterResponse"] };

const state = {
  from: null,
  to: null,
  groupBy: "site",
  siteFilter: "",
  topN: 0,
  rows: [],
  all: [],
  preciseMode: false,
  totals: { bytes: 0, requests: 0, unknown: 0, cached: 0, decoded: 0, measured: 0 },
};

async function init() {
  const today = dateKey(Date.now());
  state.to = today;
  state.from = today;
  $("from").value = today;
  $("to").value = today;

  const settings = await store.getSettings();
  $("retention").value = settings.retentionDays;
  $("excludeCached").checked = settings.excludeCached;
  state.preciseMode = !!settings.preciseMode;
  $("preciseMode").checked = state.preciseMode;

  bindControls();
  await load();
}

function bindControls() {
  $("from").addEventListener("change", (e) => { state.from = e.target.value; load(); });
  $("to").addEventListener("change", (e) => { state.to = e.target.value; load(); });
  $("groupBy").addEventListener("change", (e) => { state.groupBy = e.target.value; load(); });
  $("siteFilter").addEventListener("input", debounce((e) => { state.siteFilter = e.target.value; load(); }, 200));
  $("topN").addEventListener("change", (e) => { state.topN = Number(e.target.value) || 0; load(); });

  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  $("refresh").addEventListener("click", load);
  $("export").addEventListener("click", exportCsv);
  $("clear").addEventListener("click", clearAll);

  $("retention").addEventListener("change", (e) =>
    store.setSettings({ retentionDays: Number(e.target.value) || 0 }));
  $("excludeCached").addEventListener("change", (e) =>
    store.setSettings({ excludeCached: e.target.checked }));

  $("preciseMode").addEventListener("change", togglePreciseMode);
}

/**
 * Turn precise mode on or off. Enabling needs the optional blocking permissions,
 * which Firefox only grants from a user gesture such as this click. If the user
 * declines, the checkbox is reverted rather than left lying about the state.
 */
async function togglePreciseMode(e) {
  const box = e.target;
  if (box.checked) {
    let granted = false;
    try {
      granted = await browser.permissions.request(PRECISE_PERMISSIONS);
    } catch {
      granted = false;
    }
    if (!granted) {
      box.checked = false;
      return;
    }
  }
  await store.setSettings({ preciseMode: box.checked });
  state.preciseMode = box.checked;
  await load();
}

async function applyPreset(preset) {
  const today = dateKey(Date.now());
  if (preset === "today") {
    state.from = state.to = today;
  } else if (preset === "all") {
    const dates = await store.listDates();
    state.from = dates[0] || today;
    state.to = dates[dates.length - 1] || today;
  } else {
    const days = Number(preset);
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    state.from = dateKey(start.getTime());
    state.to = today;
  }
  $("from").value = state.from;
  $("to").value = state.to;
  await load();
}

async function load() {
  const dates = dateRange(state.from, state.to);
  const days = await store.getDays(dates);
  // Aggregate everything matching the filters first so the totals are honest,
  // then apply the top-N display limit.
  const all = aggregate(days, {
    groupBy: state.groupBy,
    siteFilter: state.siteFilter,
  });
  state.totals = sumRows(all);
  state.all = all;
  state.rows = state.topN > 0 ? all.slice(0, state.topN) : all;
  render();
}

function render() {
  const tbody = document.querySelector("#results tbody");
  tbody.textContent = "";
  const totals = state.totals;
  const max = state.rows.length ? state.rows[0].bytes : 0;

  // The decoded column only carries information when precise mode has actually
  // recorded measurements, so it is hidden otherwise rather than shown as zeros.
  const showDecoded = state.preciseMode || totals.decoded > 0;
  $("colDecoded").hidden = !showDecoded;

  $("colKey").textContent = state.groupBy === "site" ? "Site" : "Serving host";

  const totalsEl = $("totals");
  totalsEl.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = formatBytes(totals.bytes);
  totalsEl.appendChild(strong);
  let summary =
    ` wire · ${totals.requests.toLocaleString()} requests` +
    (totals.unknown ? ` · ${totals.unknown.toLocaleString()} unknown size` : "") +
    (totals.cached ? ` · ${totals.cached.toLocaleString()} cached` : "");
  if (showDecoded) {
    summary += ` · ${formatBytes(totals.decoded)} decoded` +
      (totals.measured ? ` across ${totals.measured.toLocaleString()} responses` : "");
  }
  const cov = coverage(totals);
  if (totals.unknown > 0 && cov < 1) {
    summary += ` · ${Math.round(cov * 100)}% of responses have a known wire size`;
  }
  totalsEl.appendChild(document.createTextNode(summary));

  $("empty").hidden = state.rows.length > 0;

  state.rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.appendChild(cell(String(i + 1), "num"));
    tr.appendChild(cell(row.key));
    tr.appendChild(cell(formatBytes(row.bytes), "num"));
    if (showDecoded) {
      tr.appendChild(cell(row.decoded ? formatBytes(row.decoded) : "—", "num"));
    }
    tr.appendChild(meterCell(max ? row.bytes / max : 0));
    tr.appendChild(cell(row.requests.toLocaleString(), "num"));
    tr.appendChild(cell(row.unknown.toLocaleString(), "num"));
    tr.appendChild(cell(row.cached.toLocaleString(), "num"));
    tbody.appendChild(tr);
  });
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function meterCell(fraction) {
  const td = document.createElement("td");
  td.className = "bar-col";
  const bar = document.createElement("div");
  bar.className = "meter";
  bar.style.width = `${Math.max(fraction * 100, 1)}%`;
  td.appendChild(bar);
  return td;
}

function exportCsv() {
  const csv = rowsToCsv(state.all || state.rows);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `data-usage-${state.from}_to_${state.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clearAll() {
  if (!confirm("Delete all locally stored usage data? This cannot be undone.")) return;
  await store.clearAll();
  await load();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

init().catch((err) => console.error("dashboard init failed", err));
