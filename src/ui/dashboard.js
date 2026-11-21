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
  bindTips();
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
 * Column headers and per-row error counts carry a description in data-tip. A
 * native title tooltip needs a hover, which touch screens do not have, so the
 * text is shown in a popup on focus (keyboard) and tap (touch), and on hover for
 * mice. Listeners are delegated from the document so the table cells created on
 * every render need no rebinding. The popup lives on <body> with fixed
 * positioning so the table's overflow container cannot clip it.
 */
function bindTips() {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.id = "tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);

  let current = null;

  const tipTarget = (node) =>
    node instanceof Element ? node.closest("[data-tip]") : null;

  function hide() {
    if (!current) return;
    current.removeAttribute("aria-describedby");
    current = null;
    tip.hidden = true;
  }

  function show(el) {
    if (current !== el) hide();
    current = el;
    tip.textContent = el.dataset.tip;
    el.setAttribute("aria-describedby", tip.id);
    tip.hidden = false;

    const margin = 8;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left),
      window.innerWidth - tip.offsetWidth - margin
    );
    tip.style.left = `${left}px`;
    const below = rect.bottom + 6;
    tip.style.top = below + tip.offsetHeight > window.innerHeight - margin
      ? `${Math.max(margin, rect.top - tip.offsetHeight - 6)}px`
      : `${below}px`;
  }

  document.addEventListener("click", (e) => {
    const el = tipTarget(e.target);
    if (el) show(el);
    else hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = tipTarget(e.target);
    if (el) show(el);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  if (window.matchMedia("(hover: hover)").matches) {
    document.addEventListener("mouseover", (e) => {
      const el = tipTarget(e.target);
      if (el) show(el);
    });
    document.addEventListener("mouseout", (e) => {
      if (!current) return;
      const to = e.relatedTarget;
      if (to instanceof Node && current.contains(to)) return;
      hide();
    });
  }

  document.addEventListener("scroll", () => {
    if (!current) return;
    // Focusing an element can scroll it into view, so reposition rather than
    // dismiss; only hide once it has left the viewport.
    const rect = current.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) hide();
    else show(current);
  }, true);
  window.addEventListener("resize", hide);

  // Headers are static, so they only need to be made focusable here; table
  // cells set their own tabIndex when they gain a tip.
  for (const th of document.querySelectorAll("th[data-tip]")) th.tabIndex = 0;
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

  // Decoded bytes and the unmeasured count are both precise-mode concepts: one is
  // the measurement, the other is a failure to take it. Show them only while
  // precise mode is selected, even if old measurements are still in storage.
  const showPrecise = state.preciseMode;
  $("colDecoded").hidden = !showPrecise;
  // The coverage-gap columns only appear once they have something to say.
  const showErrored = totals.errored > 0;
  const showUnmeasured = showPrecise && totals.unmeasured > 0;
  // A bodyless response (204/304/…) is a known zero, not a gap; show the count
  // only when it happened, so it reads as context rather than noise.
  const showBodyless = totals.bodyless > 0;
  // Cached bytes are always recorded separately from the wire total; the column
  // only appears once there is something cached to show.
  const showCachedBytes = totals.cachedBytes > 0;
  $("colErrored").hidden = !showErrored;
  $("colUnmeasured").hidden = !showUnmeasured;
  $("colBodyless").hidden = !showBodyless;
  $("colCachedBytes").hidden = !showCachedBytes;

  // The key column is a site or a serving host depending on the mode, so its
  // hint has to follow the header text.
  const bySite = state.groupBy === "site";
  $("colKey").textContent = bySite ? "Site" : "Serving host";
  $("colKey").dataset.tip = bySite
    ? "The website you visited, including files it loaded from other servers. Click a row to see which servers served it"
    : "A server that sent data for the sites you visited";

  const totalsEl = $("totals");
  totalsEl.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = formatBytes(totals.bytes);
  totalsEl.appendChild(strong);
  let summary =
    ` wire · ${totals.requests.toLocaleString()} requests` +
    (totals.unknown ? ` · ${totals.unknown.toLocaleString()} unknown wire size` : "") +
    (totals.bodyless ? ` · ${totals.bodyless.toLocaleString()} empty body` : "") +
    (totals.cached ? ` · ${totals.cached.toLocaleString()} cached` : "") +
    (showCachedBytes ? ` (${formatBytes(totals.cachedBytes)})` : "") +
    (showErrored ? ` · ${totals.errored.toLocaleString()} failed` : "");
  if (showPrecise) {
    summary += ` · ${formatBytes(totals.decoded)} decoded` +
      (totals.measured ? ` across ${totals.measured.toLocaleString()} responses` : "");
    if (showUnmeasured) summary += ` · ${totals.unmeasured.toLocaleString()} unmeasured`;
  }
  const cov = coverage(totals);
  if (totals.unknown > 0 && cov < 1) {
    summary += ` · ${Math.round(cov * 100)}% of non-cached requests have a known wire size`;
  }
  totalsEl.appendChild(document.createTextNode(summary));

  $("empty").hidden = state.rows.length > 0;

  const cols = {
    decoded: showPrecise,
    cachedBytes: showCachedBytes,
    errored: showErrored,
    unmeasured: showUnmeasured,
    bodyless: showBodyless,
  };
  const expandable = state.groupBy === "site";

  state.rows.forEach((row, i) => {
    const expanded = expandable && state.expanded.has(row.key);
    tbody.appendChild(rowElement(row, { index: i + 1, cols, expandable, expanded }));

    if (!expanded) return;
    // "Per site" rows are the page plus its third parties, so expand to the
    // serving hosts that made up the total.
    const hosts = hostBreakdown(state.days, row.key);
    if (hosts.length === 0) {
      tbody.appendChild(noteRow(cols, "No per-host breakdown recorded for this site."));
      return;
    }
    for (const h of hosts) {
      tbody.appendChild(rowElement(h, { cols, child: true }));
    }
  });
}

/** Number of visible table columns, used to span the note row correctly. */
function columnCount(cols) {
  return 2 + 1 + (cols.decoded ? 1 : 0) + 3 +
    (cols.cachedBytes ? 1 : 0) + (cols.errored ? 1 : 0) +
    (cols.unmeasured ? 1 : 0) + (cols.bodyless ? 1 : 0);
}

function rowElement(row, { index, cols, expandable = false, expanded = false, child = false }) {
  const tr = document.createElement("tr");
  if (child) tr.className = "host-row";
  tr.appendChild(cell(index != null ? String(index) : "", "num"));
  tr.appendChild(keyCell(row.key, { expandable, expanded, child }));
  tr.appendChild(cell(formatBytes(row.bytes), "num"));
  if (cols.decoded) {
    tr.appendChild(cell(row.decoded ? formatBytes(row.decoded) : "—", "num"));
  }
  tr.appendChild(cell(row.requests.toLocaleString(), "num"));
  tr.appendChild(cell(row.unknown.toLocaleString(), "num"));
  tr.appendChild(cell(row.cached.toLocaleString(), "num"));
  if (cols.cachedBytes) {
    tr.appendChild(cell(row.cachedBytes ? formatBytes(row.cachedBytes) : "—", "num"));
  }
  if (cols.errored) {
    tr.appendChild(errorCell(row));
  }
  if (cols.unmeasured) {
    tr.appendChild(cell(row.unmeasured.toLocaleString(), "num"));
  }
  if (cols.bodyless) {
    tr.appendChild(cell(row.bodyless.toLocaleString(), "num"));
  }
  if (expandable) {
    tr.classList.add("expandable");
    tr.addEventListener("click", (e) => {
      if (window.getSelection().toString()) return;
      // The error count is its own hover/tap target; do not also expand the row.
      if (e.target instanceof Element && e.target.closest("[data-tip]")) return;
      toggleSite(row.key);
    });
  }
  return tr;
}

/**
 * The key cell. A "site" row is clickable anywhere to reveal its per-host
 * breakdown; the host rows beneath it are plain, indented text. The button
 * carries the keyboard focus and aria-expanded state; its click bubbles to the
 * row handler, so it needs no listener of its own.
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
 * The Errors cell. Its count is the tap/hover target for that row's failure
 * histogram: `reasons` is aggregated per site and per host at collection time,
 * so explaining a row needs no per-request log.
 */
function errorCell(row) {
  const td = cell(row.errored.toLocaleString(), "num");
  if (row.errored === 0) return td;
  const reasons = errorReasons([row]);
  const total = reasons.reduce((n, r) => n + r.count, 0);
  const lines = reasons.length
    ? reasons.map(({ reason, count }) =>
      `${reason}: ${count.toLocaleString()} (${Math.round((count / total) * 100)}%)`)
    : ["No reason recorded (older data)"];
  td.dataset.tip = ["Failed requests by reason", ...lines].join("\n");
  td.tabIndex = 0;
  return td;
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
