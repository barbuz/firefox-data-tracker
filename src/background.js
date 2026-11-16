// Background event page (Firefox MV3 has no service-worker support, so this runs
// as an event page). It owns the Collector and wires it to webRequest events.

import { Store } from "./lib/store.js";
import { Collector } from "./lib/collector.js";

const store = new Store(browser.storage.local);
const collector = new Collector({
  store,
  getSettings: () => store.getSettings(),
});

const PRUNE_ALARM = "prune-and-flush";
const PRUNE_INTERVAL_MINUTES = 60;

async function bootstrap() {
  await collector.init();
  registerListeners();
  registerAlarm();
}

function registerListeners() {
  // "responseHeaders" gives us Content-Length. onCompleted is informational
  // only, so this never blocks or slows a page load.
  browser.webRequest.onCompleted.addListener(
    (details) => collector.handleCompleted(details),
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // Re-read settings when they change so toggles take effect without a reload.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      collector.applySettings(changes.settings.newValue);
    }
  });

  // Persist whatever is buffered before the event page is unloaded.
  browser.runtime.onSuspend.addListener(() => {
    collector.flush().catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "flush") return collector.flush().then(() => ({ ok: true }));
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

bootstrap().catch((err) => console.error("Data Usage Tracker failed to start", err));
