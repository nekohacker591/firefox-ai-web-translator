# AI Context Translator (Firefox Extension)

A Firefox extension that automatically translates website text using Pollinations AI.

## Features

- AI-based contextual translation (better phrasing than string-only translators)
- Bring-your-own-key (BYOK) support for Pollinations API keys
- Automatic source-language detection by the model
- Target language selector
- Model dropdown fetched from `/v1/models`
- On/Off toggle
- Text-node extraction (avoids sending full HTML to reduce token use)
- Preserves page layout by replacing only visible text and common user-facing attributes (`alt`, `title`, `placeholder`)

## Install (temporary in Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json`

## Configure

1. Click the extension icon.
2. Toggle **Enabled** on.
3. Set **Target language**.
4. Choose a **Model**.
5. Paste your Pollinations API key (`sk_` or `pk_`) if required.
6. Save.

## Notes

- Translation runs in batches to reduce rate-limit and context issues.
- Dynamic pages are observed and re-translated when new content appears.
- Elements marked with `translate="no"`, `.notranslate`, or `[data-no-translate]` are skipped.
