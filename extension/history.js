/* =========================================================
   ScamShield AI — History Page Controller
   ========================================================= */

const TYPE_ICON = { url: "🌐", email: "✉️", screenshot: "🔒", qr: "▦" };

let allHistory = [];
let activeFilter = "all";

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString()} ${time}`;
}

function applyFilter(list) {
  if (activeFilter === "all") return list;
  if (activeFilter === "danger") return list.filter((h) => h.verdict === "danger");
  return list.filter((h) => h.type === activeFilter);
}

function renderSummary(list) {
  document.getElementById("totalCount").textContent = list.length;
  document.getElementById("dangerCount").textContent = list.filter((h) => h.verdict === "danger").length;
  document.getElementById("safeCount").textContent = list.filter((h) => h.verdict === "safe").length;
}

function renderList() {
  const filtered = applyFilter(allHistory);
  const container = document.getElementById("histList");
  const empty = document.getElementById("histEmpty");

  container.innerHTML = "";

  if (filtered.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  filtered.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `hist-row ${entry.verdict === "danger" ? "danger" : entry.verdict === "safe" ? "safe" : ""}`;
    row.innerHTML = `
      <div class="hist-row-icon">${TYPE_ICON[entry.type] || "🛰"}</div>
      <div class="hist-row-main">
        <div class="hist-row-url">${escapeHtml(entry.url || "—")}</div>
        <div class="hist-row-meta">
          <span>${entry.type.toUpperCase()}</span>
          <span>${fmtTime(entry.timestamp)}</span>
        </div>
      </div>
      <div class="hist-row-score">${entry.riskScore ?? "--"}%</div>
    `;
    container.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function load() {
  const data = await chrome.storage.local.get("history");
  allHistory = data.history || [];
  renderSummary(allHistory);
  renderList();
}

document.getElementById("filters").addEventListener("click", (e) => {
  const btn = e.target.closest(".hist-filter-btn");
  if (!btn) return;
  document.querySelectorAll(".hist-filter-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  activeFilter = btn.dataset.filter;
  renderList();
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  if (!confirm("Clear all scan history? This can't be undone.")) return;
  await chrome.storage.local.set({ history: [] });
  await load();
});

document.getElementById("settingsNav").addEventListener("click", () => {
  window.location.href = "settings.html";
});

document.addEventListener("DOMContentLoaded", load);
