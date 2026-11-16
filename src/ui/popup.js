// Popup: a compact view of today's usage and the top few sites.

import { Store } from "../lib/store.js";
import { aggregate, dateKey, formatBytes, sumRows } from "../lib/aggregate.js";

const store = new Store(browser.storage.local);

async function render() {
  const today = dateKey(Date.now());
  const days = await store.getDays([today]);
  const rows = aggregate(days, { groupBy: "site" });
  const totals = sumRows(rows);

  document.getElementById("total").textContent = formatBytes(totals.bytes);

  // Decoded totals only mean anything once precise mode has measured something.
  const decodedEl = document.getElementById("decoded");
  if (totals.decoded > 0) {
    decodedEl.hidden = false;
    decodedEl.textContent = `${formatBytes(totals.decoded)} decoded (precise mode)`;
  } else {
    decodedEl.hidden = true;
  }

  const list = document.getElementById("top");
  list.textContent = "";
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No data yet today.";
    list.appendChild(li);
    return;
  }
  for (const row of rows.slice(0, 5)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = row.key;
    const size = document.createElement("span");
    size.textContent = formatBytes(row.bytes);
    li.append(name, size);
    list.appendChild(li);
  }
}

document.getElementById("open").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

render().catch((err) => console.error("popup failed", err));
