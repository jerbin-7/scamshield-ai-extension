/* =========================================================
   ScamShield AI — Backend API client + storage helpers
   Shared across background, popup, content, warning, history,
   and settings scripts. Loaded as a classic script (not a
   module) so it can be imported with importScripts() from the
   service worker and with <script> tags from HTML pages.
   ========================================================= */

const ScamShieldConfig = {
  // Change this to your deployed Flask/FastAPI backend URL.
  BASE_URL: "http://127.0.0.1:5000",
  ENDPOINTS: {
    URL_SCAN: "/api/scan/url",
    EMAIL_SCAN: "/api/scan/email",
    SCREENSHOT_SCAN: "/api/scan/screenshot",
    QR_SCAN: "/api/scan/qr",
    HEALTH: "/api/health"
  },
  TIMEOUT_MS: 12000
};

const ScamShieldDefaults = {
  settings: {
    urlDetection: true,
    qrDetection: true,
    emailDetection: true,
    screenshotDetection: true,
    notifications: true,
    darkMode: true,
    autoWarningPage: true,
    apiBaseUrl: ScamShieldConfig.BASE_URL
  }
};

/**
 * Fetch wrapper with timeout + JSON handling.
 */
async function ssFetch(path, options = {}) {
  const settings = await ScamShieldStorage.getSettings();
  const base = settings.apiBaseUrl || ScamShieldConfig.BASE_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ScamShieldConfig.TIMEOUT_MS);

  try {
    const res = await fetch(base + path, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`ScamShield API error ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

const ScamShieldAPI = {
  /**
   * Analyze a URL for phishing indicators.
   * Backend contract (see backend/app.py):
   *   POST /api/scan/url  { url }
   *   -> { verdict: "safe"|"danger", riskScore: 0-100, reasons: string[], meta: {...} }
   */
  async scanUrl(url) {
    return ssFetch(ScamShieldConfig.ENDPOINTS.URL_SCAN, {
      method: "POST",
      body: JSON.stringify({ url })
    });
  },

  /**
   * Analyze raw email text/HTML pulled from the Gmail DOM.
   *   POST /api/scan/email { subject, sender, body }
   *   -> { verdict, riskScore, reasons, meta }
   */
  async scanEmail({ subject, sender, body }) {
    return ssFetch(ScamShieldConfig.ENDPOINTS.EMAIL_SCAN, {
      method: "POST",
      body: JSON.stringify({ subject, sender, body })
    });
  },

  /**
   * Analyze a base64 screenshot of the visible page for fake login pages (CNN).
   *   POST /api/scan/screenshot { image (base64), url }
   *   -> { verdict, riskScore, reasons, meta }
   */
  async scanScreenshot({ image, url }) {
    return ssFetch(ScamShieldConfig.ENDPOINTS.SCREENSHOT_SCAN, {
      method: "POST",
      body: JSON.stringify({ image, url })
    });
  },

  /**
   * Analyze a decoded QR code payload URL.
   *   POST /api/scan/qr { decodedUrl, sourcePageUrl }
   *   -> { verdict, riskScore, reasons, meta }
   */
  async scanQr({ decodedUrl, sourcePageUrl }) {
    return ssFetch(ScamShieldConfig.ENDPOINTS.QR_SCAN, {
      method: "POST",
      body: JSON.stringify({ decodedUrl, sourcePageUrl })
    });
  },

  async health() {
    return ssFetch(ScamShieldConfig.ENDPOINTS.HEALTH, { method: "GET" });
  }
};

/**
 * chrome.storage.local wrapper for settings + scan history.
 */
const ScamShieldStorage = {
  async getSettings() {
    const data = await chrome.storage.local.get("settings");
    return { ...ScamShieldDefaults.settings, ...(data.settings || {}) };
  },

  async setSettings(partial) {
    const current = await this.getSettings();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ settings: next });
    return next;
  },

  async getHistory() {
    const data = await chrome.storage.local.get("history");
    return data.history || [];
  },

  async addHistoryEntry(entry) {
    const history = await this.getHistory();
    history.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...entry
    });
    // Cap history at 500 entries to keep storage light.
    const trimmed = history.slice(0, 500);
    await chrome.storage.local.set({ history: trimmed });
    return trimmed;
  },

  async clearHistory() {
    await chrome.storage.local.set({ history: [] });
  },

  async getAllowlist() {
    const data = await chrome.storage.local.get("allowlist");
    return data.allowlist || [];
  },

  async addToAllowlist(hostname) {
    const list = await this.getAllowlist();
    if (!list.includes(hostname)) list.push(hostname);
    await chrome.storage.local.set({ allowlist: list });
    return list;
  }
};

// UMD-ish export so this file works both as a classic script
// (globals attach to `self`/`window`) and if ever bundled.
if (typeof self !== "undefined") {
  self.ScamShieldAPI = ScamShieldAPI;
  self.ScamShieldStorage = ScamShieldStorage;
  self.ScamShieldConfig = ScamShieldConfig;
}
