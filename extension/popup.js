/* =========================================================
   ScamShield AI — Popup Controller
   ========================================================= */

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 68; // r=68, matches popup.html

const els = {
  statusLine: document.getElementById("statusLine"),
  gaugeProgress: document.getElementById("gaugeProgress"),
  gaugeScore: document.getElementById("gaugeScore"),
  verdictBadge: document.getElementById("verdictBadge"),
  domainLabel: document.getElementById("domainLabel"),
  reasonsList: document.getElementById("reasonsList"),
  rescanBtn: document.getElementById("rescanBtn"),
  allowBtn: document.getElementById("allowBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  footerHistory: document.getElementById("footerHistory"),
  footerSettings: document.getElementById("footerSettings"),
  historyLink: document.getElementById("historyLink"),
  historyLink2: document.getElementById("historyLink2"),
  statScans: document.getElementById("statScans"),
  statBlocked: document.getElementById("statBlocked"),
  toggleUrl: document.getElementById("toggleUrl"),
  toggleQr: document.getElementById("toggleQr"),
  toggleEmail: document.getElementById("toggleEmail"),
  toggleScreenshot: document.getElementById("toggleScreenshot")
};

function sendMessage(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

function setGauge(score, verdictType) {
  els.gaugeProgress.classList.remove("safe", "danger", "neutral");
  els.gaugeProgress.classList.add(verdictType);
  const offset = GAUGE_CIRCUMFERENCE - (Math.max(0, Math.min(100, score)) / 100) * GAUGE_CIRCUMFERENCE;
  els.gaugeProgress.style.strokeDashoffset = offset;
  els.gaugeScore.textContent = score;
}

function setBadge(verdict) {
  els.verdictBadge.className = "ss-badge";
  if (verdict === "danger") {
    els.verdictBadge.classList.add("ss-badge-danger");
    els.verdictBadge.innerHTML = `<span class="ss-dot"></span>Danger`;
  } else if (verdict === "safe") {
    els.verdictBadge.classList.add("ss-badge-safe");
    els.verdictBadge.innerHTML = `<span class="ss-dot"></span>Safe`;
  } else if (verdict === "unknown") {
    els.verdictBadge.classList.add("ss-badge-warn");
    els.verdictBadge.innerHTML = `<span class="ss-dot"></span>Unavailable`;
  } else {
    els.verdictBadge.classList.add("ss-badge-neutral");
    els.verdictBadge.innerHTML = `<span class="ss-dot"></span>Scanning…`;
  }
}

function renderReasons(reasons) {
  els.reasonsList.innerHTML = "";
  if (!reasons || reasons.length === 0) {
    els.reasonsList.innerHTML = `<li class="ss-reason-item ss-reason-empty">No risk signals detected.</li>`;
    return;
  }
  reasons.forEach((reason) => {
    const li = document.createElement("li");
    li.className = "ss-reason-item";
    li.textContent = reason;
    els.reasonsList.appendChild(li);
  });
}

function renderVerdict(verdict, tabUrl) {
  if (!verdict) {
    els.statusLine.textContent = "No scan yet for this tab";
    setBadge("scanning");
    setGauge(0, "neutral");
    renderReasons([]);
    els.allowBtn.hidden = true;
    return;
  }

  const type = verdict.verdict === "danger" ? "danger" : verdict.verdict === "safe" ? "safe" : "neutral";
  setGauge(verdict.riskScore ?? 0, type);
  setBadge(verdict.verdict);
  renderReasons(verdict.reasons);

  try {
    els.domainLabel.textContent = new URL(verdict.url || tabUrl).hostname;
  } catch {
    els.domainLabel.textContent = verdict.url || tabUrl || "—";
  }

  els.statusLine.textContent = verdict.error
    ? "Backend unreachable"
    : `Scanned ${timeAgo(verdict.scannedAt)}`;

  els.allowBtn.hidden = verdict.verdict !== "danger";
}

function timeAgo(ts) {
  if (!ts) return "just now";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

async function loadActiveTabVerdict() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    els.statusLine.textContent = "This page can't be scanned";
    setBadge("scanning");
    setGauge(0, "neutral");
    renderReasons(["ScamShield AI only scans http/https pages."]);
    return { tab: null, verdict: null };
  }

  const res = await sendMessage({ type: "SS_GET_TAB_VERDICT", tabId: tab.id });
  let verdict = res?.verdict;

  if (!verdict) {
    els.statusLine.textContent = "Scanning…";
    const rescan = await sendMessage({ type: "SS_RESCAN_TAB", tabId: tab.id });
    verdict = rescan?.verdict;
  }

  renderVerdict(verdict, tab.url);
  return { tab, verdict };
}

async function loadTodayStats() {
  const data = await chrome.storage.local.get("history");
  const history = data.history || [];
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todays = history.filter((h) => h.timestamp >= startOfDay.getTime());
  els.statScans.textContent = todays.length;
  els.statBlocked.textContent = todays.filter((h) => h.verdict === "danger").length;
}

async function loadSettingsIntoToggles() {
  const res = await sendMessage({ type: "SS_GET_SETTINGS" });
  const s = res?.settings || {};
  els.toggleUrl.checked = !!s.urlDetection;
  els.toggleQr.checked = !!s.qrDetection;
  els.toggleEmail.checked = !!s.emailDetection;
  els.toggleScreenshot.checked = !!s.screenshotDetection;
}

function wireToggle(el, key) {
  el.addEventListener("change", () => {
    sendMessage({ type: "SS_SET_SETTINGS", settings: { [key]: el.checked } });
  });
}

function openPage(page) {
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
}

async function init() {
  const { tab } = await loadActiveTabVerdict();
  await loadTodayStats();
  await loadSettingsIntoToggles();

  wireToggle(els.toggleUrl, "urlDetection");
  wireToggle(els.toggleQr, "qrDetection");
  wireToggle(els.toggleEmail, "emailDetection");
  wireToggle(els.toggleScreenshot, "screenshotDetection");

  els.rescanBtn.addEventListener("click", async () => {
    if (!tab) return;
    els.statusLine.textContent = "Rescanning…";
    setBadge("scanning");
    const res = await sendMessage({ type: "SS_RESCAN_TAB", tabId: tab.id });
    renderVerdict(res?.verdict, tab.url);
    loadTodayStats();
  });

  els.allowBtn.addEventListener("click", async () => {
    if (!tab) return;
    const hostname = new URL(tab.url).hostname;
    await sendMessage({ type: "SS_ALLOW_SITE", hostname });
    els.allowBtn.textContent = "Trusted ✓";
    els.allowBtn.disabled = true;
  });

  els.settingsBtn.addEventListener("click", () => openPage("settings.html"));
  els.footerSettings.addEventListener("click", () => openPage("settings.html"));
  els.footerHistory.addEventListener("click", () => openPage("history.html"));
  els.historyLink.addEventListener("click", () => openPage("history.html"));
  els.historyLink2.addEventListener("click", () => openPage("history.html"));
}

document.addEventListener("DOMContentLoaded", init);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SS_URL_VERDICT_READY") {
    loadActiveTabVerdict();
    loadTodayStats();
  }
});
