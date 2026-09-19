/* =========================================================
   ScamShield AI — Content Script
   Runs on every http(s) page. Talks to background.js only —
   never calls the backend directly, so CORS + config stay
   centralized in one place.
   ========================================================= */

(function () {
  "use strict";

  let settingsCache = null;

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => resolve(response));
    });
  }

  async function getSettings() {
    if (settingsCache) return settingsCache;
    const res = await sendMessage({ type: "SS_GET_SETTINGS" });
    settingsCache = res?.settings || {};
    return settingsCache;
  }

  /* ---------------------------------------------------------
     Toast UI — reusable glass notification injected into DOM
  --------------------------------------------------------- */

  function ensureToastRoot() {
    let root = document.getElementById("scamshield-toast-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "scamshield-toast-root";
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function showToast({ title, message, verdictType = "neutral", actions = [], sticky = false }) {
    const root = ensureToastRoot();
    const toast = document.createElement("div");
    toast.className = `ss-toast ss-toast-${verdictType}`;
    toast.innerHTML = `
      <div class="ss-toast-icon">${verdictType === "danger" ? "⚠" : verdictType === "safe" ? "✓" : "🛰"}</div>
      <div class="ss-toast-body">
        <div class="ss-toast-title">${title}</div>
        <div class="ss-toast-message">${message}</div>
        <div class="ss-toast-actions"></div>
      </div>
      <button class="ss-toast-close" aria-label="Dismiss">×</button>
    `;
    const actionsEl = toast.querySelector(".ss-toast-actions");
    actions.forEach(({ label, onClick, kind }) => {
      const btn = document.createElement("button");
      btn.className = `ss-toast-btn ss-toast-btn-${kind || "ghost"}`;
      btn.textContent = label;
      btn.addEventListener("click", () => {
        onClick();
        toast.remove();
      });
      actionsEl.appendChild(btn);
    });
    toast.querySelector(".ss-toast-close").addEventListener("click", () => toast.remove());
    root.appendChild(toast);

    if (!sticky) {
      setTimeout(() => toast.remove(), 9000);
    }
    return toast;
  }

  /* ---------------------------------------------------------
     1) Fake Login Page Detection (screenshot -> CNN backend)
  --------------------------------------------------------- */

  function pageLooksLikeLogin() {
    const passwordFields = document.querySelectorAll('input[type="password"]');
    if (passwordFields.length === 0) return false;
    const forms = document.querySelectorAll("form");
    return passwordFields.length > 0 && (forms.length > 0 || true);
  }

  async function offerLoginPageCheck() {
    const settings = await getSettings();
    if (!settings.screenshotDetection) return;
    if (!pageLooksLikeLogin()) return;
    if (sessionStorage.getItem("scamshield-login-check-dismissed")) return;

    showToast({
      title: "Login page detected",
      message: "Want ScamShield AI to verify this isn't a fake login page? A screenshot of the visible page will be analyzed.",
      verdictType: "neutral",
      sticky: true,
      actions: [
        {
          label: "Scan this page",
          kind: "primary",
          onClick: runLoginScreenshotScan
        },
        {
          label: "Not now",
          kind: "ghost",
          onClick: () => sessionStorage.setItem("scamshield-login-check-dismissed", "1")
        }
      ]
    });
  }

  async function runLoginScreenshotScan() {
    const capture = await sendMessage({ type: "SS_CAPTURE_VISIBLE_TAB" });
    if (!capture?.ok) {
      showToast({
        title: "Couldn't capture screenshot",
        message: capture?.error || "Please try again.",
        verdictType: "danger"
      });
      return;
    }
    showToast({ title: "Analyzing page…", message: "Running fake-login detection.", verdictType: "neutral" });

    const res = await sendMessage({
      type: "SS_SCAN_SCREENSHOT",
      image: capture.dataUrl,
      url: location.href
    });

    if (!res?.ok) {
      showToast({ title: "Scan failed", message: res?.error || "Backend unreachable.", verdictType: "danger" });
      return;
    }

    const v = res.verdict;
    showToast({
      title: v.verdict === "danger" ? "Fake login page detected" : "Login page looks legitimate",
      message: `Risk score: ${v.riskScore}%${v.reasons?.length ? " — " + v.reasons[0] : ""}`,
      verdictType: v.verdict === "danger" ? "danger" : "safe"
    });
  }

  /* ---------------------------------------------------------
     2) QR Code Detection (in-page images/canvases -> jsQR)
  --------------------------------------------------------- */

  function collectCandidateImages() {
    const imgs = Array.from(document.querySelectorAll("img")).filter((img) => {
      return img.naturalWidth >= 60 && img.naturalWidth <= 1000 && img.complete;
    });
    const canvases = Array.from(document.querySelectorAll("canvas"));
    return { imgs, canvases };
  }

  function decodeImageElement(img) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // jsQR is loaded before this script via manifest content_scripts order.
      return self.jsQR(imageData.data, imageData.width, imageData.height);
    } catch (e) {
      // Cross-origin images will throw a SecurityError on getImageData — skip silently.
      return null;
    }
  }

  function decodeCanvasElement(canvas) {
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return self.jsQR(imageData.data, imageData.width, imageData.height);
    } catch (e) {
      return null;
    }
  }

  const scannedQrPayloads = new Set();

  async function scanPageForQrCodes() {
    const settings = await getSettings();
    if (!settings.qrDetection) return;
    if (typeof self.jsQR !== "function") return;

    const { imgs, canvases } = collectCandidateImages();
    const found = [];

    for (const img of imgs) {
      const result = decodeImageElement(img);
      if (result?.data) found.push({ el: img, data: result.data });
    }
    for (const canvas of canvases) {
      const result = decodeCanvasElement(canvas);
      if (result?.data) found.push({ el: canvas, data: result.data });
    }

    for (const { el, data } of found) {
      if (scannedQrPayloads.has(data)) continue;
      scannedQrPayloads.add(data);
      handleDecodedQr(data, el);
    }
  }

  async function handleDecodedQr(decodedUrl, el) {
    const res = await sendMessage({
      type: "SS_SCAN_QR",
      decodedUrl,
      sourcePageUrl: location.href
    });
    if (!res?.ok) return;

    const v = res.verdict;
    markQrElement(el, v.verdict);
    showToast({
      title: v.verdict === "danger" ? "Dangerous QR code found" : "QR code scanned — looks safe",
      message: `${decodedUrl.slice(0, 60)}${decodedUrl.length > 60 ? "…" : ""} · Risk score ${v.riskScore}%`,
      verdictType: v.verdict === "danger" ? "danger" : "safe"
    });
  }

  function markQrElement(el, verdict) {
    try {
      const rect = el.getBoundingClientRect();
      const marker = document.createElement("div");
      marker.className = `ss-qr-marker ss-qr-marker-${verdict}`;
      marker.style.top = `${window.scrollY + rect.top - 6}px`;
      marker.style.left = `${window.scrollX + rect.left - 6}px`;
      marker.style.width = `${rect.width + 12}px`;
      marker.style.height = `${rect.height + 12}px`;
      marker.title = verdict === "danger" ? "ScamShield AI: dangerous QR code" : "ScamShield AI: verified safe";
      document.body.appendChild(marker);
    } catch (e) {
      /* non-fatal */
    }
  }

  /* ---------------------------------------------------------
     3) Gmail "Analyze Email" injection
  --------------------------------------------------------- */

  function isGmail() {
    return location.hostname === "mail.google.com";
  }

  function extractOpenEmail() {
    // Gmail's DOM is obfuscated/versioned; these selectors target the
    // reading pane's semantic roles, which are more stable than class names.
    const subjectEl = document.querySelector('h2[data-thread-perm-id], h2.hP');
    const senderEl = document.querySelector('span.gD, span[email]');
    const bodyEl = document.querySelector('div.a3s, div[role="listitem"] div.ii.gt');

    if (!bodyEl) return null;

    return {
      subject: subjectEl?.textContent?.trim() || "(no subject)",
      sender: senderEl?.getAttribute("email") || senderEl?.textContent?.trim() || "unknown",
      body: bodyEl.innerText?.trim()?.slice(0, 20000) || ""
    };
  }

  function injectGmailButton() {
    const toolbar = document.querySelector('div[role="toolbar"]');
    if (!toolbar || toolbar.querySelector(".ss-gmail-btn")) return;

    const btn = document.createElement("button");
    btn.className = "ss-gmail-btn";
    btn.type = "button";
    btn.innerHTML = `<span class="ss-gmail-btn-icon">🛡</span> Analyze Email`;
    btn.addEventListener("click", async () => {
      const email = extractOpenEmail();
      if (!email) {
        showToast({ title: "No email open", message: "Open an email first, then click Analyze.", verdictType: "neutral" });
        return;
      }
      showToast({ title: "Analyzing email…", message: "Checking for phishing indicators.", verdictType: "neutral" });
      const res = await sendMessage({ type: "SS_SCAN_EMAIL", email });
      if (!res?.ok) {
        showToast({ title: "Scan failed", message: res?.error || "Backend unreachable.", verdictType: "danger" });
        return;
      }
      const v = res.verdict;
      showToast({
        title: v.verdict === "danger" ? "Phishing email detected" : "Email looks safe",
        message: `Risk score: ${v.riskScore}%${v.reasons?.length ? " — " + v.reasons[0] : ""}`,
        verdictType: v.verdict === "danger" ? "danger" : "safe"
      });
    });
    toolbar.appendChild(btn);
  }

  function watchGmail() {
    injectGmailButton();
    const observer = new MutationObserver(() => injectGmailButton());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------
     Boot
  --------------------------------------------------------- */

  async function init() {
    const settings = await getSettings();

    if (settings.screenshotDetection) {
      // Give the page a moment to fully render before checking for login forms.
      setTimeout(offerLoginPageCheck, 1500);
    }
    if (settings.qrDetection) {
      setTimeout(scanPageForQrCodes, 1200);
      const observer = new MutationObserver(() => scanPageForQrCodes());
      observer.observe(document.body, { childList: true, subtree: true });
    }
    if (isGmail() && settings.emailDetection) {
      watchGmail();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
