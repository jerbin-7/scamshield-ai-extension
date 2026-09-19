/* =========================================================
   ScamShield AI — Settings Page Controller
   ========================================================= */

const TOGGLE_IDS = [
  "urlDetection",
  "qrDetection",
  "emailDetection",
  "screenshotDetection",
  "notifications",
  "autoWarningPage",
  "darkMode"
];

function sendMessage(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

function applyTheme(isDark) {
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}

function showSaved() {
  const el = document.getElementById("savedIndicator");
  el.classList.add("show");
  clearTimeout(showSaved._t);
  showSaved._t = setTimeout(() => el.classList.remove("show"), 1600);
}

async function load() {
  const res = await sendMessage({ type: "SS_GET_SETTINGS" });
  const s = res?.settings || {};

  TOGGLE_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!s[id];
  });

  document.getElementById("apiBaseUrl").value = s.apiBaseUrl || "";
  applyTheme(s.darkMode !== false);
}

function wireToggles() {
  TOGGLE_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", async () => {
      await sendMessage({ type: "SS_SET_SETTINGS", settings: { [id]: el.checked } });
      if (id === "darkMode") applyTheme(el.checked);
      showSaved();
    });
  });
}

function wireApiUrl() {
  const input = document.getElementById("apiBaseUrl");
  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      await sendMessage({ type: "SS_SET_SETTINGS", settings: { apiBaseUrl: input.value.trim() } });
      showSaved();
    }, 500);
  });
}

function wireTestConnection() {
  document.getElementById("testConnBtn").addEventListener("click", async () => {
    const statusEl = document.getElementById("connStatus");
    statusEl.textContent = "Testing…";
    statusEl.className = "settings-conn-status";
    try {
      const health = await ScamShieldAPI.health();
      statusEl.textContent = `Connected ✓ ${health?.status ? `(${health.status})` : ""}`;
      statusEl.classList.add("ok");
    } catch (err) {
      statusEl.textContent = `Couldn't reach backend: ${err.message}`;
      statusEl.classList.add("fail");
    }
  });
}

function wireDataActions() {
  document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
    if (!confirm("Clear all scan history?")) return;
    await chrome.storage.local.set({ history: [] });
    showSaved();
  });

  document.getElementById("clearAllowlistBtn").addEventListener("click", async () => {
    if (!confirm("Reset all trusted sites?")) return;
    await chrome.storage.local.set({ allowlist: [] });
    showSaved();
  });
}

document.getElementById("historyNav").addEventListener("click", () => {
  window.location.href = "history.html";
});

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  wireToggles();
  wireApiUrl();
  wireTestConnection();
  wireDataActions();
});
