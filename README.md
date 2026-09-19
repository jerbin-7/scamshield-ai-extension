# ScamShield AI — Chrome Extension

Converts the ScamShield AI web app into a Manifest V3 Chrome extension that
protects users automatically while they browse, backed by your existing
Flask/FastAPI backend and trained ML models.

```
scamshield-extension/
├── extension/              ← load this folder as an unpacked extension
│   ├── manifest.json
│   ├── background.js       (service worker: URL scans, notifications, message router)
│   ├── content.js          (login-page + QR detection, Gmail button)
│   ├── content.css
│   ├── popup.html/.css/.js (toolbar dashboard)
│   ├── warning.html/.css/.js (full-page phishing interstitial)
│   ├── history.html/.css/.js (scan history)
│   ├── settings.html/.css/.js
│   ├── shared/
│   │   ├── theme.css       (design tokens used by every page)
│   │   └── api.js          (backend API client + chrome.storage helpers)
│   ├── lib/jsQR.js         (QR decoding library)
│   └── icons/
└── backend/
    ├── app.py              (Flask API — wraps your existing models)
    ├── requirements.txt
    └── models/             (drop your .pkl / .h5 files here)
```

---

## 1. Connect the extension to your Flask API

The extension never talks to your model code directly — it calls a small
REST contract exposed by `backend/app.py`:

| Endpoint              | Method | Body                              | Returns                                          |
|------------------------|--------|-------------------------------------|--------------------------------------------------|
| `/api/scan/url`        | POST   | `{ url }`                           | `{ verdict, riskScore, reasons[], meta }`         |
| `/api/scan/email`      | POST   | `{ subject, sender, body }`         | `{ verdict, riskScore, reasons[], meta }`         |
| `/api/scan/screenshot` | POST   | `{ image (base64), url }`           | `{ verdict, riskScore, reasons[], meta }`         |
| `/api/scan/qr`         | POST   | `{ decodedUrl, sourcePageUrl }`     | `{ verdict, riskScore, reasons[], meta }`         |
| `/api/health`          | GET    | —                                    | `{ status, models: {...} }`                       |

`verdict` is `"safe"` or `"danger"`, `riskScore` is 0–100.

**To wire up your existing models:**

1. Copy your trained files into `backend/models/`:
   - `url_model.pkl` (+ optional `url_vectorizer.pkl`)
   - `email_model.pkl` (+ optional `email_vectorizer.pkl`)
   - `login_cnn.h5`
2. Open `backend/app.py` → `predict_url()` and adjust the feature vector
   passed to `_models["url_model"].predict_proba(...)` so it matches the
   exact feature order your model was trained on. The same applies to
   `predict_email()` if your model expects a specific vectorizer input shape.
3. If your existing project already has feature-extraction or preprocessing
   functions, import them into `app.py` in place of `extract_url_features()`
   / `rule_based_email_score()` — those two functions are the seam where
   your original ScamShield AI logic plugs in.

Until your model files are in place, every endpoint still works using a
transparent, rule-based fallback scorer, so you can test the full extension
end-to-end immediately.

Install and run:

```bash
cd backend
pip install -r requirements.txt
python app.py
# Backend now running at http://127.0.0.1:5000
```

The extension's default backend URL is `http://127.0.0.1:5000`. To point it
at a different host (e.g. your deployed API), open the extension's
**Settings** page and update "Backend connection", or edit
`extension/shared/api.js` → `ScamShieldConfig.BASE_URL`.

If you deploy the backend elsewhere, add that origin to
`host_permissions` in `manifest.json` and restrict CORS in `app.py`
(`CORS(app, origins=["chrome-extension://<your-extension-id>"])`).

---

## 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The ScamShield AI shield icon appears in your toolbar

Any time you edit a file, go back to `chrome://extensions` and click the
refresh icon on the ScamShield AI card to reload it.

---

## 3. Test it

With the backend running (`python app.py`):

- **URL detection**: visit any `http(s)://` page — the toolbar badge and
  popup update automatically. Try a URL with an IP address or many
  subdomains to see the rule-based fallback flag it.
- **Warning page**: visit a page that scores ≥60 risk (or temporarily lower
  the threshold in `app.py`'s `predict_url`) to see the full-page interstitial.
- **Login page detection**: visit any page with a password field — a toast
  will offer to scan it. Requires `activeTab` permission, granted automatically
  when you click the extension or the toast button.
- **QR detection**: visit a page containing a QR code `<img>` — ScamShield
  decodes it client-side with jsQR and sends only the decoded URL to your backend.
- **Email detection**: open Gmail, open any email, click the **Analyze Email**
  button injected into the toolbar.
- **History & Settings**: click the popup's History/Settings buttons, or the
  toolbar icon → gear icon.

---

## 4. Package for production

```bash
cd extension
zip -r ../scamshield-ai-extension.zip . -x ".*"
```

Or from `chrome://extensions` → **Pack extension** → select the `extension/`
folder (Chrome generates a `.crx` + `.pem` key pair; keep the `.pem` private
and reuse it for all future updates so the extension ID stays stable).

Before shipping:
- Point `ScamShieldConfig.BASE_URL` (or the Settings page) at your production
  backend, served over HTTPS.
- Tighten `host_permissions` in `manifest.json` to only the domains you need,
  if you don't require scanning every site.
- Restrict CORS in `app.py` to your published extension's ID.
- Replace the generated placeholder icons in `extension/icons/` with your
  final brand assets if desired (same filenames/sizes: 16/32/48/128).

---

## 5. Publish to the Chrome Web Store

1. Create a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole) (one-time $5 fee).
2. Zip the `extension/` folder as shown above.
3. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), click **New Item** and upload the `.zip`.
4. Fill in the store listing: description, screenshots (1280×800 or 640×400),
   promo tile images, and a privacy policy URL — required because this
   extension reads page content and requests `activeTab`/`tabs`/`webNavigation`
   permissions.
5. Under **Privacy practices**, disclose that URLs, email content, and
   screenshots are sent to your backend for phishing analysis.
6. Submit for review. Manifest V3 extensions with broad host permissions
   often take longer to review — expect it to take from a few days up to a
   couple of weeks.
7. Once approved, future updates just require uploading a new `.zip` with an
   incremented `"version"` in `manifest.json`.

---

## Notes on permissions

- `activeTab` + `tabs`: read the current tab's URL, capture a screenshot for
  login-page scanning.
- `scripting`: inject the content script logic where needed.
- `webNavigation`: trigger a URL scan on every top-level navigation.
- `storage`: store settings, scan history, and the trusted-sites allowlist locally.
- `notifications`: show the "⚠ Danger!" system notification.
- `host_permissions` (`http://*/*`, `https://*/*`): required so the extension
  can read the URL of any page you visit and call the backend from the
  content script's page context. If you only need this for specific sites,
  narrow this list.
