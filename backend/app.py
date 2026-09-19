"""
ScamShield AI — Backend API for the Chrome Extension
======================================================

This Flask app exposes the exact REST contract the browser extension
calls (see extension/shared/api.js). It is designed to sit in front
of YOUR EXISTING ScamShield AI models — drop your trained artifacts
into backend/models/ using the filenames below and this app will load
and use them automatically:

    models/url_model.pkl          scikit-learn phishing-URL classifier
    models/url_vectorizer.pkl     feature scaler/vectorizer for the URL model (optional)
    models/email_model.pkl        scikit-learn phishing-email classifier
    models/email_vectorizer.pkl   TF-IDF vectorizer for the email model (optional)
    models/login_cnn.h5           Keras/TensorFlow CNN for fake-login screenshot detection

If a given model file is not present, that endpoint automatically
falls back to a transparent, rule-based heuristic scorer (fully
functional, not a stub) so the extension keeps working end-to-end
while you finish wiring up your trained models.

Run:
    pip install -r requirements.txt
    python app.py
"""

import base64
import io
import os
import re
import socket
from datetime import datetime, timezone
from urllib.parse import urlparse

from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Optional heavy deps — imported lazily / defensively so the API still boots
# and serves rule-based responses even if TensorFlow/sklearn aren't installed
# yet, or your model files aren't in place.
# ---------------------------------------------------------------------------
try:
    import joblib
except ImportError:
    joblib = None

try:
    import numpy as np
except ImportError:
    np = None

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    import tensorflow as tf
except ImportError:
    tf = None


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "models")

app = Flask(__name__)
# Chrome extensions call this API from a chrome-extension:// origin.
# Restrict this in production to your extension's ID, e.g.:
#   CORS(app, origins=["chrome-extension://<your-extension-id>"])
CORS(app)


# ---------------------------------------------------------------------------
# Model loading (lazy, cached, defensive)
# ---------------------------------------------------------------------------

_models = {"url_model": None, "url_vectorizer": None, "email_model": None,
           "email_vectorizer": None, "login_cnn": None, "_loaded": False}


def load_models():
    """Load whichever trained model files are present. Safe to call repeatedly."""
    if _models["_loaded"]:
        return
    _models["_loaded"] = True

    if joblib is not None:
        url_model_path = os.path.join(MODELS_DIR, "url_model.pkl")
        if os.path.exists(url_model_path):
            try:
                _models["url_model"] = joblib.load(url_model_path)
                print(f"[ScamShield] Loaded URL model from {url_model_path}")
            except Exception as e:
                print(f"[ScamShield] Failed to load URL model: {e}")

        url_vec_path = os.path.join(MODELS_DIR, "url_vectorizer.pkl")
        if os.path.exists(url_vec_path):
            try:
                _models["url_vectorizer"] = joblib.load(url_vec_path)
            except Exception as e:
                print(f"[ScamShield] Failed to load URL vectorizer: {e}")

        email_model_path = os.path.join(MODELS_DIR, "email_model.pkl")
        if os.path.exists(email_model_path):
            try:
                _models["email_model"] = joblib.load(email_model_path)
                print(f"[ScamShield] Loaded email model from {email_model_path}")
            except Exception as e:
                print(f"[ScamShield] Failed to load email model: {e}")

        email_vec_path = os.path.join(MODELS_DIR, "email_vectorizer.pkl")
        if os.path.exists(email_vec_path):
            try:
                _models["email_vectorizer"] = joblib.load(email_vec_path)
            except Exception as e:
                print(f"[ScamShield] Failed to load email vectorizer: {e}")

    if tf is not None:
        cnn_path = os.path.join(MODELS_DIR, "login_cnn.h5")
        if os.path.exists(cnn_path):
            try:
                _models["login_cnn"] = tf.keras.models.load_model(cnn_path)
                print(f"[ScamShield] Loaded login CNN from {cnn_path}")
            except Exception as e:
                print(f"[ScamShield] Failed to load login CNN: {e}")


# ---------------------------------------------------------------------------
# URL feature extraction + rule-based fallback scorer
# ---------------------------------------------------------------------------

SUSPICIOUS_KEYWORDS = [
    "login", "verify", "secure", "account", "update", "confirm", "banking",
    "signin", "password", "webscr", "ebayisapi", "paypal", "suspend",
    "unlock", "wallet", "gift", "prize", "urgent", "invoice"
]

SHORTENER_DOMAINS = {
    "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly",
    "rebrand.ly", "cutt.ly", "shorte.st"
}


def is_ip_address(host: str) -> bool:
    try:
        socket.inet_aton(host)
        return True
    except (OSError, TypeError):
        return False


def extract_url_features(url: str) -> dict:
    parsed = urlparse(url if "://" in url else f"http://{url}")
    hostname = parsed.hostname or ""
    path = parsed.path or ""
    full = url.lower()

    subdomain_count = max(0, hostname.count(".") - 1) if hostname else 0

    return {
        "url_length": len(url),
        "hostname_length": len(hostname),
        "uses_ip": is_ip_address(hostname),
        "uses_https": parsed.scheme == "https",
        "subdomain_count": subdomain_count,
        "has_at_symbol": "@" in url,
        "hyphen_count": hostname.count("-"),
        "dot_count": url.count("."),
        "digit_ratio": (sum(c.isdigit() for c in url) / len(url)) if url else 0,
        "is_shortener": hostname in SHORTENER_DOMAINS,
        "suspicious_keyword_hits": [kw for kw in SUSPICIOUS_KEYWORDS if kw in full],
        "path_depth": len([p for p in path.split("/") if p]),
        "has_port": parsed.port is not None,
        "hostname": hostname
    }


def rule_based_url_score(features: dict) -> tuple:
    """Returns (riskScore 0-100, reasons[]) using transparent, explainable rules."""
    score = 5  # baseline
    reasons = []

    if features["uses_ip"]:
        score += 30
        reasons.append("Uses a raw IP address instead of a domain name")

    if features["url_length"] > 75:
        score += 15
        reasons.append("Unusually long URL")

    if not features["uses_https"]:
        score += 12
        reasons.append("Connection is not encrypted (no HTTPS)")

    if features["subdomain_count"] >= 3:
        score += 15
        reasons.append("Excessive number of subdomains")

    if features["has_at_symbol"]:
        score += 20
        reasons.append("URL contains an '@' symbol, often used to disguise the real destination")

    if features["hyphen_count"] >= 3:
        score += 10
        reasons.append("Domain contains many hyphens")

    if features["is_shortener"]:
        score += 12
        reasons.append("Uses a URL shortening service, which can hide the real destination")

    if features["suspicious_keyword_hits"]:
        score += min(20, 6 * len(features["suspicious_keyword_hits"]))
        kw_list = ", ".join(features["suspicious_keyword_hits"][:3])
        reasons.append(f"Contains suspicious keywords ({kw_list})")

    if features["digit_ratio"] > 0.3:
        score += 8
        reasons.append("Unusually high proportion of digits in the URL")

    if features["path_depth"] >= 5:
        score += 6
        reasons.append("Deeply nested URL path")

    score = max(0, min(100, score))
    if not reasons:
        reasons.append("No suspicious structural patterns detected")

    return score, reasons


def predict_url(url: str) -> dict:
    load_models()
    features = extract_url_features(url)

    if _models["url_model"] is not None and np is not None:
        try:
            # Adjust this vector to match the exact feature order your
            # trained model expects. This ordering matches extract_url_features().
            vector = np.array([[
                features["url_length"],
                features["hostname_length"],
                int(features["uses_ip"]),
                int(features["uses_https"]),
                features["subdomain_count"],
                int(features["has_at_symbol"]),
                features["hyphen_count"],
                features["dot_count"],
                features["digit_ratio"],
                int(features["is_shortener"]),
                len(features["suspicious_keyword_hits"]),
                features["path_depth"],
                int(features["has_port"]),
            ]])

            if _models["url_vectorizer"] is not None:
                vector = _models["url_vectorizer"].transform(vector)

            proba = _models["url_model"].predict_proba(vector)[0]
            # Assumes class index 1 = phishing, matching typical binary labeling.
            phishing_proba = float(proba[1]) if len(proba) > 1 else float(proba[0])
            risk_score = round(phishing_proba * 100)
            _, reasons = rule_based_url_score(features)  # keep explainability
            verdict = "danger" if risk_score >= 60 else "safe"
            return {"verdict": verdict, "riskScore": risk_score, "reasons": reasons,
                    "meta": {"source": "ml_model", "hostname": features["hostname"]}}
        except Exception as e:
            print(f"[ScamShield] URL model inference failed, falling back to rules: {e}")

    risk_score, reasons = rule_based_url_score(features)
    verdict = "danger" if risk_score >= 60 else "safe"
    return {"verdict": verdict, "riskScore": risk_score, "reasons": reasons,
            "meta": {"source": "rule_based", "hostname": features["hostname"]}}


# ---------------------------------------------------------------------------
# Email feature extraction + rule-based fallback scorer
# ---------------------------------------------------------------------------

EMAIL_URGENCY_PHRASES = [
    "act now", "verify your account", "suspended", "unusual activity",
    "click here", "limited time", "confirm your identity", "update your payment",
    "your account will be", "immediately", "final notice", "winner", "claim your"
]


def rule_based_email_score(subject: str, sender: str, body: str) -> tuple:
    score = 5
    reasons = []
    text = f"{subject}\n{body}".lower()

    hits = [p for p in EMAIL_URGENCY_PHRASES if p in text]
    if hits:
        score += min(35, 8 * len(hits))
        reasons.append(f"Uses urgency/pressure language ({hits[0]})")

    urls = re.findall(r"https?://[^\s\"'<>]+", body)
    if urls:
        risky_links = 0
        for u in urls[:10]:
            feats = extract_url_features(u)
            s, _ = rule_based_url_score(feats)
            if s >= 60:
                risky_links += 1
        if risky_links:
            score += min(30, 15 * risky_links)
            reasons.append(f"Contains {risky_links} link(s) with phishing-like URL patterns")

    if sender and re.search(r"@(?!gmail\.com|outlook\.com|yahoo\.com)[a-z0-9.-]+\.(xyz|top|click|country|gq|tk)$",
                             sender.lower()):
        score += 20
        reasons.append("Sender uses an uncommon, high-risk top-level domain")

    if re.search(r"\b(ssn|social security|bank account|routing number|credit card|otp|one[- ]time password)\b", text):
        score += 20
        reasons.append("Requests sensitive personal or financial information")

    if len(re.findall(r"[!]{2,}", text)) or text.count("$") > 3:
        score += 8
        reasons.append("Excessive punctuation or currency symbols, common in scam emails")

    score = max(0, min(100, score))
    if not reasons:
        reasons.append("No suspicious language or link patterns detected")

    return score, reasons


def predict_email(subject: str, sender: str, body: str) -> dict:
    load_models()

    if _models["email_model"] is not None:
        try:
            text_input = f"{subject} {body}"
            if _models["email_vectorizer"] is not None:
                vector = _models["email_vectorizer"].transform([text_input])
            else:
                vector = [text_input]

            proba = _models["email_model"].predict_proba(vector)[0]
            phishing_proba = float(proba[1]) if len(proba) > 1 else float(proba[0])
            risk_score = round(phishing_proba * 100)
            _, reasons = rule_based_email_score(subject, sender, body)
            verdict = "danger" if risk_score >= 60 else "safe"
            return {"verdict": verdict, "riskScore": risk_score, "reasons": reasons,
                    "meta": {"source": "ml_model", "sender": sender}}
        except Exception as e:
            print(f"[ScamShield] Email model inference failed, falling back to rules: {e}")

    risk_score, reasons = rule_based_email_score(subject, sender, body)
    verdict = "danger" if risk_score >= 60 else "safe"
    return {"verdict": verdict, "riskScore": risk_score, "reasons": reasons,
            "meta": {"source": "rule_based", "sender": sender}}


# ---------------------------------------------------------------------------
# Screenshot (fake login page) prediction via CNN
# ---------------------------------------------------------------------------

def decode_base64_image(data_url: str):
    if Image is None:
        raise RuntimeError("Pillow is not installed on the server (pip install Pillow)")
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def predict_screenshot(image_data_url: str, url: str) -> dict:
    load_models()

    if _models["login_cnn"] is not None and np is not None:
        try:
            img = decode_base64_image(image_data_url)
            target_size = _models["login_cnn"].input_shape[1:3]  # (height, width)
            img_resized = img.resize((target_size[1], target_size[0]))
            arr = np.array(img_resized).astype("float32") / 255.0
            arr = np.expand_dims(arr, axis=0)

            pred = _models["login_cnn"].predict(arr, verbose=0)
            phishing_proba = float(pred[0][0])
            risk_score = round(phishing_proba * 100)
            verdict = "danger" if risk_score >= 60 else "safe"
            reasons = (
                ["Visual layout closely matches known fake login page patterns"]
                if verdict == "danger"
                else ["Visual layout matches expected legitimate login page structure"]
            )
            return {"verdict": verdict, "riskScore": risk_score, "reasons": reasons,
                    "meta": {"source": "cnn_model", "url": url}}
        except Exception as e:
            print(f"[ScamShield] CNN inference failed: {e}")
            return {"verdict": "unknown", "riskScore": 0,
                    "reasons": [f"Screenshot analysis failed: {e}"],
                    "meta": {"source": "cnn_model_error", "url": url}}

    # No CNN model loaded yet — respond honestly instead of guessing.
    return {
        "verdict": "unknown",
        "riskScore": 0,
        "reasons": [
            "No fake-login CNN model is loaded on the server yet.",
            "Add backend/models/login_cnn.h5 to enable this check."
        ],
        "meta": {"source": "no_model", "url": url}
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health():
    load_models()
    return jsonify({
        "status": "ok",
        "time": datetime.now(timezone.utc).isoformat(),
        "models": {
            "url_model": _models["url_model"] is not None,
            "email_model": _models["email_model"] is not None,
            "login_cnn": _models["login_cnn"] is not None
        }
    })


@app.route("/api/scan/url", methods=["POST"])
def scan_url():
    payload = request.get_json(silent=True) or {}
    url = (payload.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Missing 'url' in request body"}), 400
    return jsonify(predict_url(url))


@app.route("/api/scan/email", methods=["POST"])
def scan_email():
    payload = request.get_json(silent=True) or {}
    subject = payload.get("subject", "")
    sender = payload.get("sender", "")
    body = payload.get("body", "")
    if not body and not subject:
        return jsonify({"error": "Missing email content"}), 400
    return jsonify(predict_email(subject, sender, body))


@app.route("/api/scan/screenshot", methods=["POST"])
def scan_screenshot():
    payload = request.get_json(silent=True) or {}
    image = payload.get("image")
    url = payload.get("url", "")
    if not image:
        return jsonify({"error": "Missing 'image' (base64) in request body"}), 400
    return jsonify(predict_screenshot(image, url))


@app.route("/api/scan/qr", methods=["POST"])
def scan_qr():
    payload = request.get_json(silent=True) or {}
    decoded_url = (payload.get("decodedUrl") or "").strip()
    if not decoded_url:
        return jsonify({"error": "Missing 'decodedUrl' in request body"}), 400
    result = predict_url(decoded_url)
    result["meta"]["sourcePageUrl"] = payload.get("sourcePageUrl")
    return jsonify(result)


if __name__ == "__main__":
    load_models()
    app.run(host="127.0.0.1", port=5000, debug=True)
