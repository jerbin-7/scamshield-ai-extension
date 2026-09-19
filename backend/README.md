# 🛡️ ScamShield AI

ScamShield AI is an AI-powered browser extension designed to help users identify potential phishing and scam threats while browsing the web.

The project combines a Chrome browser extension with a Python Flask backend and machine learning models to analyze suspicious URLs, emails, screenshots, and QR-code links.

---

## 🚀 Features

### 🔗 Phishing URL Detection
Analyzes URLs for suspicious patterns and provides a risk score and verdict.

### 📧 Phishing Email Detection
Analyzes email subject, sender, and body content to identify potential phishing characteristics.

### 🖼️ Fake Login Page Detection
Analyzes screenshots of webpages using a CNN-based model to identify potentially fake login pages.

### 📱 QR Code Phishing Detection
Decodes QR-code URLs and analyzes the destination for phishing-related characteristics.

### ⚠️ Risk Warning
Provides users with a danger/safe verdict and explains the reasons behind the detection.

### 📜 Scan History
Stores previous scan results locally in the browser extension.

### ⚙️ Settings
Allows users to configure detection features and extension preferences.

---

## 🏗️ System Architecture

```text
                    ┌─────────────────────────┐
                    │     Chrome Extension    │
                    │                         │
                    │  URL / Email / QR /     │
                    │  Screenshot Detection   │
                    └────────────┬────────────┘
                                 │
                                 │ HTTP API
                                 ▼
                    ┌─────────────────────────┐
                    │     Flask Backend       │
                    │                         │
                    │  REST API Endpoints     │
                    └────────────┬────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
          URL Detection    Email Detection   Screenshot
          ML Model         ML Model          CNN Model
                │                │                │
                └────────────────┼────────────────┘
                                 │
                                 ▼
                         Risk Score + Verdict