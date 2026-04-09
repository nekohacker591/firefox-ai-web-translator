const DEFAULT_SETTINGS = {
  enabled: false,
  targetLanguage: "English",
  model: "mistral",
  apiKey: "",
  forceTranslateHosts: [],
  systemPrompt:
    "You are an expert website translator. Detect the source language automatically for each text segment and translate into the target language only when needed. If text is already in the target language, keep it unchanged. Preserve meaning, tone, punctuation, emojis, placeholders, brand names, URLs, and code snippets."
};

const MAX_TRANSLATION_RETRIES = 4;
const BASE_RETRY_DELAY_MS = 400;
const MIN_TIME_BETWEEN_REQUESTS_MS = 120;
let lastTranslateAt = 0;
let translationQueue = Promise.resolve();
const translationCache = new Map();
const MAX_CACHE_ENTRIES = 2000;

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await browser.storage.local.set(next);
  return next;
}

async function forceTranslateForUrl(url) {
  if (!url) {
    return getSettings();
  }

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return getSettings();
  }

  const settings = await getSettings();
  const nextHosts = Array.from(new Set([...(settings.forceTranslateHosts || []), host]));
  return saveSettings({ forceTranslateHosts: nextHosts });
}

async function listModels() {
  try {
    const response = await fetch("https://gen.pollinations.ai/v1/models", {
      method: "GET"
    });
    if (!response.ok) {
      throw new Error(`Model listing failed with status ${response.status}`);
    }

    const payload = await response.json();
    const raw = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];
    const models = raw
      .map((item) => item?.id)
      .filter((id) => typeof id === "string" && id.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));

    return models.length > 0 ? models : [DEFAULT_SETTINGS.model];
  } catch (error) {
    console.warn("Unable to fetch models. Falling back to defaults.", error);
    return [
      "openai",
      "openai-fast",
      "openai-large",
      "mistral",
      "mistral-large",
      "qwen-coder",
      "claude-fast",
      "deepseek",
      "gemini-fast"
    ];
  }
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCacheKey(model, targetLanguage, text) {
  return `${model}::${targetLanguage}::${text}`;
}

function isRateLimitResponse(status, bodyText) {
  if (status === 429) {
    return true;
  }
  if (status === 502 && /429|too many requests/i.test(bodyText || "")) {
    return true;
  }
  return false;
}

async function performTranslateRequest(settings, userPrompt) {
  const now = Date.now();
  const waitMs = Math.max(0, MIN_TIME_BETWEEN_REQUESTS_MS - (now - lastTranslateAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  let attempt = 0;
  while (attempt <= MAX_TRANSLATION_RETRIES) {
    attempt += 1;

    const response = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              `${settings.systemPrompt}\n` +
              "You will receive JSON: {targetLanguage, items:[{id,text}]}. Detect language per item. Translate only items not already in targetLanguage. Return only JSON in this exact format: {\"translations\":[{\"id\":\"...\",\"text\":\"...\"},...]} preserving the same ids. Do not invent or remove ids."
          },
          {
            role: "user",
            content: userPrompt
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    lastTranslateAt = Date.now();
    if (response.ok) {
      return response.json();
    }

    const body = await response.text().catch(() => "");
    if (attempt <= MAX_TRANSLATION_RETRIES && isRateLimitResponse(response.status, body)) {
      const backoff = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      await sleep(backoff);
      continue;
    }

    throw new Error(`Translate request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  throw new Error("Translate request failed after retries due to rate limits.");
}

async function translateBatch({ texts, targetLanguage }) {
  const settings = await getSettings();

  if (!settings.enabled) {
    return { translations: texts, skipped: true, reason: "disabled" };
  }

  if (!settings.apiKey) {
    return { translations: texts, skipped: true, reason: "missing_key" };
  }

  const segments = Array.isArray(texts?.segments)
    ? texts.segments
    : Array.isArray(texts)
      ? texts.map((text, idx) => ({ id: String(idx), text }))
      : [];

  if (segments.length === 0) {
    return { translations: [] };
  }

  const resolved = new Array(segments.length);
  const missing = [];

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const sourceText = typeof seg?.text === "string" ? seg.text : "";
    const segId = typeof seg?.id === "string" ? seg.id : String(i);
    const key = makeCacheKey(settings.model, targetLanguage, sourceText);
    if (translationCache.has(key)) {
      resolved[i] = { id: segId, text: translationCache.get(key) };
    } else {
      missing.push({ id: segId, text: sourceText, index: i });
    }
  }

  if (missing.length === 0) {
    return { translations: resolved.map((item) => item.text), segments: resolved };
  }

  const userPrompt = JSON.stringify({
    targetLanguage,
    items: missing.map((item) => ({ id: item.id, text: item.text }))
  });

  const payload = await performTranslateRequest(settings, userPrompt);
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error("Missing translation content from API response.");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (error) {
    throw new Error(`Invalid translation JSON from model: ${error.message}`);
  }

  const output = Array.isArray(parsed?.translations) ? parsed.translations : [];
  const byId = new Map();
  for (const item of output) {
    if (item && typeof item.id === "string" && typeof item.text === "string") {
      byId.set(item.id, item.text);
    }
  }

  for (const item of missing) {
    const sourceText = item.text;
    const translatedText = byId.get(item.id) || sourceText;
    resolved[item.index] = { id: item.id, text: translatedText };
    translationCache.set(makeCacheKey(settings.model, targetLanguage, sourceText), translatedText);
    if (translationCache.size > MAX_CACHE_ENTRIES) {
      translationCache.clear();
    }
  }

  return {
    translations: resolved.map((item) => item?.text || ""),
    segments: resolved
  };
}

function queueTranslateBatch(payload) {
  const task = translationQueue
    .catch(() => undefined)
    .then(() => translateBatch(payload));
  translationQueue = task;
  return task;
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  switch (message.type) {
    case "GET_SETTINGS":
      return getSettings();
    case "SAVE_SETTINGS":
      return saveSettings(message.payload || {});
    case "FORCE_TRANSLATE_FOR_URL":
      return forceTranslateForUrl(message.payload?.url);
    case "LIST_MODELS":
      return listModels().then((models) => ({ models }));
    case "TRANSLATE_BATCH":
      return queueTranslateBatch(message.payload || {});
    default:
      return undefined;
  }
});
