// Background event page (Firefox MV3 has no service-worker support, so this runs
// as an event page). It owns the Collector and wires it to webRequest events.

import { Store } from "./lib/store.js";
import { Collector } from "./lib/collector.js";
import { StreamTracker } from "./lib/streams.js";
import { siteKeyForRequest, servingHostForRequest } from "./lib/domain.js";

const store = new Store(browser.storage.local);
const collector = new Collector({
  store,
  getSettings: () => store.getSettings(),
});

const tracker = new StreamTracker({
  createFilter: (requestId) => browser.webRequest.filterResponseData(requestId),
  onMeasure: (meta, decodedBytes) => collector.handleMeasured(meta, decodedBytes),
  onSkip: (meta) => collector.handleSkipped(meta),
});

const PRUNE_ALARM = "prune-and-flush";
const PRUNE_INTERVAL_MINUTES = 60;

const PRECISE_PERMISSIONS = ["webRequestBlocking", "webRequestFilterResponse"];

// Precise mode is the only reason this extension ever registers a blocking
// listener, so the listener is added and removed with the setting rather than
// always being present.
let preciseListener = null;
// syncPreciseMode has await points before it checks preciseListener, so two
// concurrent calls (bootstrap + a settings change) could both add the listener,
// which throws. Serialise the calls instead.
let syncChain = Promise.resolve();

// Register listeners synchronously, before any await. A non-persistent (event
// page) background only restarts for events whose listeners were registered
// during the synchronous first run of the page; registering after an await
// (e.g. after loading settings) means those events no longer wake the page, and
// the requests they carry are silently lost. See MDN "Background scripts →
// Add listeners".
registerListeners();
registerAlarm();

// Load persisted settings and reconcile precise mode. Safe to do after the
// listeners are live: the collector treats a missing setting as its default.
bootstrap().catch((err) => console.error("Data Usage Tracker failed to start", err));

async function bootstrap() {
  await collector.init();
  await syncPreciseMode();
}

function registerListeners() {
  // "responseHeaders" gives us Content-Length. onCompleted is informational
  // only, so this never blocks or slows a page load.
  browser.webRequest.onCompleted.addListener(
    (details) => collector.handleCompleted(details),
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // Requests that failed mid-flight (cancelled downloads, network errors) can
  // still have transferred bytes we can never see. Counting them keeps those
  // bytes from silently vanishing from the totals.
  browser.webRequest.onErrorOccurred.addListener(
    (details) => collector.handleErrored(details),
    { urls: ["<all_urls>"] }
  );

  // Re-read settings when they change so toggles take effect without a reload.
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && changes.settings) {
      collector.applySettings(changes.settings.newValue);
      await syncPreciseMode();
    }
  });

  // Persist whatever is buffered before the event page is unloaded. Open
  // filters are disconnected first so their partial totals are not lost and no
  // response is left hanging on a filter that will never fire again.
  browser.runtime.onSuspend.addListener(() => {
    tracker.stopAll();
    collector.flush().catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "flush") return collector.flush().then(() => ({ ok: true }));
    if (msg?.type === "preciseState") return Promise.resolve({ active: !!preciseListener });
    return undefined;
  });
}

function registerAlarm() {
  // Safety-net flush plus periodic retention pruning. Periodic alarms do not
  // need the "alarms" permission in Firefox, but we request it for clarity.
  browser.alarms.create(PRUNE_ALARM, { periodInMinutes: PRUNE_INTERVAL_MINUTES });
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== PRUNE_ALARM) return;
    await collector.flush().catch(() => {});
    const settings = await store.getSettings();
    await store.prune(settings.retentionDays).catch(() => {});
  });
}

/** Attach a measuring stream filter to every response, when enabled and allowed. */
function onBeforeRequest(details) {
  // Speculative connections have no real tab and are not a document request.
  if (details.type === "speculative") return undefined;

  const site = siteKeyForRequest(details);
  if (!site) return undefined;

  tracker.attach(details.requestId, {
    requestId: details.requestId,
    site,
    host: servingHostForRequest(details),
    timeStamp: details.timeStamp || Date.now(),
  });
  // Returning nothing lets the request continue untouched; the filter only
  // observes and re-writes the body as it passes through.
  return undefined;
}

function syncPreciseMode() {
  syncChain = syncChain.then(applyPreciseMode, applyPreciseMode);
  return syncChain;
}

async function applyPreciseMode() {
  try {
    const settings = await store.getSettings();
    const wanted = !!settings.preciseMode;
    const allowed = wanted && (await hasPrecisePermissions());

    if (allowed && !preciseListener) {
      // Registered in onBeforeRequest so the filter exists before Firefox's
      // optimized byte cache for scripts is consulted (see filterResponseData).
      browser.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        { urls: ["<all_urls>"] },
        ["blocking"]
      );
      preciseListener = onBeforeRequest;
    } else if (!allowed && preciseListener) {
      browser.webRequest.onBeforeRequest.removeListener(preciseListener);
      preciseListener = null;
      tracker.stopAll();
    }
  } catch (err) {
    // Never reject: the sync chain must stay usable for the next settings change.
    console.error("Could not update precise mode", err);
  }
  return !!preciseListener;
}

async function hasPrecisePermissions() {
  try {
    return await browser.permissions.contains({ permissions: PRECISE_PERMISSIONS });
  } catch {
    return false;
  }
}
