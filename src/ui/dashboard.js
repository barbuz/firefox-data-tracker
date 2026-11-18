// Dashboard: loads aggregated day buckets from storage, applies the date-range
// and site filters, and renders the results table. All data stays local.

import { Store } from "../lib/store.js";
import {
  aggregate,
  hostBreakdown,
  dateRange,
  dateKey,
  formatBytes,
  sumRows,
  rowsToCsv,
  coverage,
  errorReasons,
} from "../lib/aggregate.js";
import { entriesToCsv } from "../lib/requestlog.js";

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
  days: [],
  expanded: new Set(),
  preciseMode: false,
  totals: { bytes: 0, requests: 0, unknown: 0, cached: 0, cachedBytes: 0, decoded: 0, measured: 0, errored: 0, unmeasured: 0 },
};

async function init() {
  const today = dateKey(Date.now());
  state.to = today;
  state.from = today;
  $("from").value = today;
  $("to").value = today;

  const settings = await store.getSettings();
  $("retention").value = settings.retentionDays;
  state.preciseMode = !!settings.preciseMode;
  $("preciseMode").checked = state.preciseMode;
  $("requestLog").checked = !!settings.requestLog;

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
  $("exportLog").addEventListener("click", exportLog);
  $("clear").addEventListener("click", clearAll);

  $("retention").addEventListener("change", (e) =>
    store.setSettings({ retentionDays: Number(e.target.value) || 0 }));

  $("preciseMode").addEventListener("change", togglePreciseMode);
  $("requestLog").addEventListener("change", (e) =>
    store.setSettings({ requestLog: e.target.checked }));
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
  state.days = days;
  // Aggregate everything matching the filters first so the totals are honest,
  // then apply the top-N display limit.
  const all = aggregate(days, {
    groupBy: state.groupBy,
    siteFilter: state.siteFilter,
  });
  state.totals = sumRows(all);
  state.all = all;
  state.rows = state.topN > 0 ? all.slice(0, state.topN) : all;
  // A row that is no longer shown (or no longer exists) should not stay expanded.
  const shown = new Set(state.rows.map((r) => r.key));
  for (const key of [...state.expanded]) if (!shown.has(key)) state.expanded.delete(key);
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
  // Same for the coverage-gap columns: only shown when they have something to say.
  const showErrored = totals.errored > 0;
  const showUnmeasured = totals.unmeasured > 0;
  // Cached bytes are always recorded separately from the wire total; the column
  // only appears once there is something cached to show.
  const showCachedBytes = totals.cachedBytes > 0;
  $("colErrored").hidden = !showErrored;
  $("colUnmeasured").hidden = !showUnmeasured;
  $("colCachedBytes").hidden = !showCachedBytes;

  $("colKey").textContent = state.groupBy === "site" ? "Site" : "Serving host";

  const totalsEl = $("totals");
  totalsEl.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = formatBytes(totals.bytes);
  totalsEl.appendChild(strong);
  let summary =
    ` wire · ${totals.requests.toLocaleString()} requests` +
    (totals.unknown ? ` · ${totals.unknown.toLocaleString()} unknown size` : "") +
    (totals.cached ? ` · ${totals.cached.toLocaleString()} cached` : "") +
    (showCachedBytes ? ` (${formatBytes(totals.cachedBytes)})` : "") +
    (showErrored ? ` · ${totals.errored.toLocaleString()} failed` : "");
  if (showDecoded) {
    summary += ` · ${formatBytes(totals.decoded)} decoded` +
      (totals.measured ? ` across ${totals.measured.toLocaleString()} responses` : "");
    if (showUnmeasured) summary += ` · ${totals.unmeasured.toLocaleString()} unmeasured`;
  }
  const cov = coverage(totals);
  if (totals.unknown > 0 && cov < 1) {
    summary += ` · ${Math.round(cov * 100)}% of responses have a known wire size`;
  }
  totalsEl.appendChild(document.createTextNode(summary));

  $("empty").hidden = state.rows.length > 0;

  renderReasons(state.all);

  const cols = {
    decoded: showDecoded,
    cachedBytes: showCachedBytes,
    errored: showErrored,
    unmeasured: showUnmeasured,
  };
  const expandable = state.groupBy === "site";

  state.rows.forEach((row, i) => {
    const expanded = expandable && state.expanded.has(row.key);
    tbody.appendChild(rowElement(row, { index: i + 1, cols, max, expandable, expanded }));

    if (!expanded) return;
    // "Per site" rows are the page plus its third parties, so expand to the
    // serving hosts that made up the total. Bars are scaled to the largest host
    // so the breakdown reads on its own terms.
    const hosts = hostBreakdown(state.days, row.key);
    if (hosts.length === 0) {
      tbody.appendChild(noteRow(cols, "No per-host breakdown recorded for this site."));
      return;
    }
    const hostMax = hosts[0].bytes;
    for (const h of hosts) {
      tbody.appendChild(rowElement(h, { cols, max: hostMax, child: true }));
    }
  });
}

/** Number of visible table columns, used to span the note row correctly. */
function columnCount(cols) {
  return 2 + 1 + (cols.decoded ? 1 : 0) + 1 + 3 +
    (cols.cachedBytes ? 1 : 0) + (cols.errored ? 1 : 0) + (cols.unmeasured ? 1 : 0);
}

function rowElement(row, { index, cols, max, expandable = false, expanded = false, child = false }) {
  const tr = document.createElement("tr");
  if (child) tr.className = "host-row";
  tr.appendChild(cell(index != null ? String(index) : "", "num"));
  tr.appendChild(keyCell(row.key, { expandable, expanded, child }));
  tr.appendChild(cell(formatBytes(row.bytes), "num"));
  if (cols.decoded) {
    tr.appendChild(cell(row.decoded ? formatBytes(row.decoded) : "—", "num"));
  }
  tr.appendChild(meterCell(max ? row.bytes / max : 0));
  tr.appendChild(cell(row.requests.toLocaleString(), "num"));
  tr.appendChild(cell(row.unknown.toLocaleString(), "num"));
  tr.appendChild(cell(row.cached.toLocaleString(), "num"));
  if (cols.cachedBytes) {
    tr.appendChild(cell(row.cachedBytes ? formatBytes(row.cachedBytes) : "—", "num"));
  }
  if (cols.errored) {
    tr.appendChild(cell(row.errored.toLocaleString(), "num"));
  }
  if (cols.unmeasured) {
    tr.appendChild(cell(row.unmeasured.toLocaleString(), "num"));
  }
  return tr;
}

/**
 * The key cell. A "site" row is clickable to reveal its per-host breakdown; the
 * host rows beneath it are plain, indented text.
 */
function keyCell(key, { expandable, expanded, child }) {
  const td = document.createElement("td");
  if (child) td.className = "host-key";
  if (!expandable) {
    td.textContent = key;
    return td;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "row-toggle";
  btn.setAttribute("aria-expanded", String(expanded));
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = expanded ? "▾" : "▸";
  const name = document.createElement("span");
  name.textContent = key;
  btn.append(chevron, name);
  btn.addEventListener("click", () => toggleSite(key));
  td.appendChild(btn);
  return td;
}

function toggleSite(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  render();
}

function noteRow(cols, text) {
  const tr = document.createElement("tr");
  tr.className = "host-row";
  tr.appendChild(cell("", "num"));
  const td = document.createElement("td");
  td.className = "host-key note";
  td.colSpan = columnCount(cols) - 1;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
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

/**
 * Render the error-reason breakdown. This is the answer to "what are the main
 * reasons for errors": the Errors column says how many failed, this says why.
 * Hidden entirely when nothing failed, so it adds no noise on a clean day.
 */
function renderReasons(rows) {
  const reasons = errorReasons(rows);
  const section = $("reasons");
  section.hidden = reasons.length === 0;
  const list = $("reasonsList");
  list.textContent = "";
  const total = reasons.reduce((n, r) => n + r.count, 0);
  for (const { reason, count } of reasons) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = reason;
    const value = document.createElement("span");
    value.className = "num";
    value.textContent = `${count.toLocaleString()} (${Math.round((count / total) * 100)}%)`;
    li.append(label, value);
    list.appendChild(li);
  }
}

/**
 * Download the detailed per-request log for the current date range as CSV. The
 * log is only present when the opt-in toggle was on while those requests
 * happened, so an empty file here means the log was off, not that nothing ran.
 */
async function exportLog() {
  const dates = dateRange(state.from, state.to);
  const days = await store.getLogs(dates);
  const entries = days.flatMap((d) => d.entries);
  if (entries.length === 0) {
    alert(
      "No detailed log rows for this range.\n\n" +
      "Enable \"Detailed request log\" to start recording one line per request."
    );
    return;
  }
  const blob = new Blob([entriesToCsv(entries)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `data-usage-log-${state.from}_to_${state.to}.csv`;
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
