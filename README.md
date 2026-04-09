# AI Web Translator (Firefox Extension)

A Firefox extension that translates webpage text using AI models from the Pollinations API.

## Features

- **Auto language detection** (handled by AI prompt).
- **Bring your own key (BYOK)** using Pollinations API keys (`sk_` or `pk_`).
- **Model picker** populated from `GET /v1/models`.
- **On/off toggle** and configurable **target language**.
- **Context-aware translation prompt** designed for webpages.
- **DOM text-node extraction** (not full HTML), helping preserve layout and reduce token usage.
- **Dynamic page support** via `MutationObserver`.

## Install (Temporary Add-on in Firefox)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on**.
4. Select `manifest.json` from this folder.

## Configure

1. Open the extension popup.
2. Enable **Translator**.
3. Set your **target language**.
4. Pick a **model**.
5. Paste your Pollinations API key.
6. Save settings.

The extension will translate visible text nodes and continue translating newly added content.
