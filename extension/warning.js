/* =========================================================
   ScamShield AI — Warning Page Controller
   ========================================================= */

function getParams() {
  const params = new URLSearchParams(location.search);
  let reasons = [];
  try {
    reasons = JSON.parse(params.get("reasons") || "[]");
  } catch {
    reasons = [];
  }
  return {
    url: params.get("url") || "",
    score: Number(params.get("score") || 0),
    reasons
  };
}

function render() {
  const { url, score, reasons } = getParams();

  document.getElementById("targetUrl").textContent = url || "Unknown URL";
  document.getElementById("scoreNum").textContent = Number.isFinite(score) ? score : "--";

  const list = document.getElementById("reasonsList");
  list.innerHTML = "";
  const items = reasons.length ? reasons : ["This page matched known phishing patterns."];
  items.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    list.appendChild(li);
  });

  document.getElementById("leaveBtn").addEventListener("click", () => {
    // Send the user somewhere safe rather than just closing (closing can be blocked for the last tab).
    location.href = "https://www.google.com/search?q=is+this+site+safe";
  });

  document.getElementById("proceedBtn").addEventListener("click", async () => {
    if (!url) return;
    try {
      const hostname = new URL(url).hostname;
      chrome.runtime.sendMessage({ type: "SS_ALLOW_SITE", hostname }, () => {
        location.href = url;
      });
    } catch {
      location.href = url;
    }
  });
}

document.addEventListener("DOMContentLoaded", render);
