/* =========================================================
   ScamShield AI — Background Service Worker (MV3, module)
   Responsibilities:
     - Scan every top-level navigation's URL against the backend
     - Cache verdicts per tab so popup/content script can read them
     - Fire browser notifications on danger verdicts
     - Redirect to the warning page on high-risk sites
     - Relay screenshot / QR / email scan requests from content
       scripts and the popup (keeps a single source of truth for
       the API base URL and avoids CORS surprises in content
       script contexts)
   ========================================================= */

import "./shared/api.js";

// In a module service worker, imported classic-script side effects
// attach to `self`, so ScamShieldAPI / ScamShieldStorage are available here.

/** In-memory cache: tabId -> latest verdict object */
const tabVerdicts = new Map();

function isScannableUrl(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

async function notifyIfDangerous(verdict, url) {
  const settings = await self.ScamShieldStorage.getSettings();
  if (!settings.notifications) return;
  if (verdict.verdict !== "danger") return;

  chrome.notifications.create(`ss-danger-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "⚠ ScamShield AI — Danger!",
    message: `This website is likely phishing.\nRisk score: ${verdict.riskScore}%\n${new URL(url).hostname}`,
    priority: 2
  });
}

async function maybeShowWarningPage(tabId, verdict, originalUrl) {
  const settings = await self.ScamShieldStorage.getSettings();
  if (!settings.autoWarningPage) return;
  if (verdict.verdict !== "danger") return;

  const allowlist = await self.ScamShieldStorage.getAllowlist();
  const hostname = new URL(originalUrl).hostname;
  if (allowlist.includes(hostname)) return;

  const warningUrl = chrome.runtime.getURL(
    `warning.html?url=${encodeURIComponent(originalUrl)}&score=${verdict.riskScore}` +
      `&reasons=${encodeURIComponent(JSON.stringify(verdict.reasons || []))}`
  );
  chrome.tabs.update(tabId, { url: warningUrl });
}

/**
 * Core URL scan pipeline, triggered on navigation.
 */
async function scanTabUrl(tabId, url) {
  const settings = await self.ScamShieldStorage.getSettings();
  if (!settings.urlDetection) return;
  if (!isScannableUrl(url)) return;

  try {
    const verdict = await self.ScamShieldAPI.scanUrl(url);
    tabVerdicts.set(tabId, { ...verdict, url, scannedAt: Date.now() });

    chrome.action.setBadgeText({
      tabId,
      text: verdict.verdict === "danger" ? "!" : ""
    });
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: verdict.verdict === "danger" ? "#ff3b5c" : "#00ffa3"
    });

    await self.ScamShieldStorage.addHistoryEntry({
      type: "url",
      url,
      verdict: verdict.verdict,
      riskScore: verdict.riskScore,
      reasons: verdict.reasons || []
    });

    await notifyIfDangerous(verdict, url);
    await maybeShowWarningPage(tabId, verdict, url);

    // Let popup/content script know a fresh verdict is ready.
    chrome.runtime.sendMessage({
      type: "SS_URL_VERDICT_READY",
      tabId,
      verdict: tabVerdicts.get(tabId)
    }).catch(() => {
      /* no listeners open — that's fine */
    });
  } catch (err) {
    console.warn("[ScamShield] URL scan failed:", err.message);
    tabVerdicts.set(tabId, {
      verdict: "unknown",
      riskScore: 0,
      reasons: ["Backend unreachable — could not analyze this page."],
      url,
      error: true,
      scannedAt: Date.now()
    });
    chrome.action.setBadgeText({ tabId, text: "?" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#8a97b8" });
  }
}

// Trigger on committed top-level navigations (covers typed URLs, links, redirects).
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // top frame only
  scanTabUrl(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVerdicts.delete(tabId);
});

/**
 * Central message router used by popup.js, content.js, warning.js, history.js, settings.js
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message });
  });
  return true; // keep the message channel open for async sendResponse
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "SS_GET_TAB_VERDICT": {
      const tabId = message.tabId ?? sender.tab?.id;
      return { ok: true, verdict: tabVerdicts.get(tabId) || null };
    }

    case "SS_RESCAN_TAB": {
      const tab = sender.tab || (await chrome.tabs.get(message.tabId));
      await scanTabUrl(tab.id, tab.url);
      return { ok: true, verdict: tabVerdicts.get(tab.id) };
    }

    case "SS_SCAN_QR": {
      const verdict = await self.ScamShieldAPI.scanQr({
        decodedUrl: message.decodedUrl,
        sourcePageUrl: message.sourcePageUrl
      });
      await self.ScamShieldStorage.addHistoryEntry({
        type: "qr",
        url: message.decodedUrl,
        sourcePageUrl: message.sourcePageUrl,
        verdict: verdict.verdict,
        riskScore: verdict.riskScore,
        reasons: verdict.reasons || []
      });
      await notifyIfDangerous(verdict, message.decodedUrl);
      return { ok: true, verdict };
    }

    case "SS_SCAN_EMAIL": {
      const verdict = await self.ScamShieldAPI.scanEmail(message.email);
      await self.ScamShieldStorage.addHistoryEntry({
        type: "email",
        url: message.email.sender || "unknown-sender",
        verdict: verdict.verdict,
        riskScore: verdict.riskScore,
        reasons: verdict.reasons || []
      });
      await notifyIfDangerous(verdict, "https://mail.google.com");
      return { ok: true, verdict };
    }

    case "SS_SCAN_SCREENSHOT": {
      const verdict = await self.ScamShieldAPI.scanScreenshot({
        image: message.image,
        url: message.url
      });
      await self.ScamShieldStorage.addHistoryEntry({
        type: "screenshot",
        url: message.url,
        verdict: verdict.verdict,
        riskScore: verdict.riskScore,
        reasons: verdict.reasons || []
      });
      await notifyIfDangerous(verdict, message.url);
      return { ok: true, verdict };
    }

    case "SS_CAPTURE_VISIBLE_TAB": {
      const tab = sender.tab || (await chrome.tabs.get(message.tabId));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { ok: true, dataUrl };
    }

    case "SS_ALLOW_SITE": {
      await self.ScamShieldStorage.addToAllowlist(message.hostname);
      return { ok: true };
    }

    case "SS_GET_SETTINGS": {
      const settings = await self.ScamShieldStorage.getSettings();
      return { ok: true, settings };
    }

    case "SS_SET_SETTINGS": {
      const settings = await self.ScamShieldStorage.setSettings(message.settings);
      return { ok: true, settings };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await self.ScamShieldStorage.setSettings({});
    chrome.notifications.create("ss-welcome", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "ScamShield AI is active",
      message: "Real-time phishing protection is now running in your browser."
    });
  }
});
