# Model directory

Copy your existing trained artifacts here, using these exact filenames so
`app.py` picks them up automatically:

| File                     | What it is                                              |
|---------------------------|----------------------------------------------------------|
| `url_model.pkl`           | scikit-learn phishing-URL classifier                     |
| `url_vectorizer.pkl`      | (optional) feature scaler/vectorizer for the URL model   |
| `email_model.pkl`         | scikit-learn phishing-email classifier                   |
| `email_vectorizer.pkl`    | (optional) TF-IDF vectorizer for the email model         |
| `login_cnn.h5`            | Keras/TensorFlow CNN for fake-login screenshot detection |

If a file is missing, the corresponding endpoint automatically falls back
to a transparent rule-based scorer (URL/email) or reports "no model loaded"
(screenshot) — the API keeps working end-to-end either way.

**Important:** the feature vector built in `extract_url_features()` /
`predict_url()` inside `app.py` must match the exact feature order your
`url_model.pkl` was trained on. Adjust the vector construction in
`predict_url()` to match your training pipeline.
