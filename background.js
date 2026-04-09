const DEFAULT_SETTINGS = {
  enabled: false,
  targetLanguage: "English",
  model: "nova-fast",
  batchParallel: 2,
  apiKey: "",
  forceTranslateHosts: [],
  systemPrompt:
    "You are an expert website translator. Detect the source language automatically for each text segment and translate into the target language only when needed. If text is already in the target language, keep it unchanged. Preserve meaning, tone, punctuation, emojis, placeholders, brand names, URLs, and code snippets."
};

const MAX_TRANSLATION_RETRIES = 4;
const BASE_RETRY_DELAY_MS = 400;
const translationCache = new Map();
const MAX_CACHE_ENTRIES = 2000;
const DISPATCH_GAP_MS = 1000;
const queuedTasks = [];
let activeTasks = 0;
let schedulerRunning = false;
let nextDispatchAt = 0;
const NON_TEXT_MODEL_HINTS = [
  "audio",
  "image",
  "video",
  "whisper",
  "scribe",
  "eleven",
  "music",
  "canvas",
  "reel",
  "veo",
  "wan-image",
  "wan-fast",
  "seedance",
  "grok-video",
  "ltx",
  "p-video",
  "kontext",
  "flux",
  "zimage",
  "gptimage",
  "nanobanana",
  "qwen-image",
  "nova-canvas"
];

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const sanitized = { ...partial };
  if (sanitized.batchParallel !== undefined) {
    const numeric = Number.parseInt(String(sanitized.batchParallel), 10);
    sanitized.batchParallel = Math.min(5, Math.max(1, Number.isFinite(numeric) ? numeric : 2));
  }
  const next = { ...current, ...sanitized };
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
      .filter((id) => {
        const lower = id.toLowerCase();
        return !NON_TEXT_MODEL_HINTS.some((hint) => lower.includes(hint));
      })
      .sort((a, b) => a.localeCompare(b));

    return models.length > 0 ? models : [DEFAULT_SETTINGS.model];
  } catch (error) {
    console.warn("Unable to fetch models. Falling back to defaults.", error);
    return [
      "openai",
      "openai-fast",
      "openai-large",
      "nova-fast",
      "nova",
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

function parseTaggedTranslations(raw) {
  const cleaned = stripCodeFence(raw || "").trim();
  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      const pipeIndex = line.indexOf("|");
      const splitIndex = tabIndex >= 0 ? tabIndex : pipeIndex;
      if (splitIndex < 0) {
        return null;
      }

      const id = line.slice(0, splitIndex).trim();
      const text = line.slice(splitIndex + 1).trim();
      if (!id) {
        return null;
      }
      return { id, text };
    })
    .filter(Boolean);
}

function extractAssistantContent(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload === "object") {
    const direct = payload?.choices?.[0]?.message?.content;
    if (typeof direct === "string") {
      return direct;
    }

    if (typeof payload?.content === "string") {
      return payload.content;
    }
  }

  return "";
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
              "Translate each line to targetLanguage only if needed. Input format is lines: id<TAB>text. Output only lines in same format id<TAB>translated_text. Keep IDs unchanged. No JSON, no markdown, no explanations."
          },
          {
            role: "user",
            content: userPrompt
          }
        ]
      })
    });

    if (response.ok) {
      const payload = await response.json();
      return extractAssistantContent(payload);
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
  const uniqueByText = new Map();

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const sourceText = typeof seg?.text === "string" ? seg.text : "";
    const segId = typeof seg?.id === "string" ? seg.id : String(i);
    const key = makeCacheKey(settings.model, targetLanguage, sourceText);
    if (translationCache.has(key)) {
      resolved[i] = { id: segId, text: translationCache.get(key) };
    } else {
      let unique = uniqueByText.get(sourceText);
      if (!unique) {
        unique = { id: `u${uniqueByText.size}`, text: sourceText, indexes: [], ids: [] };
        uniqueByText.set(sourceText, unique);
      }
      unique.indexes.push(i);
      unique.ids.push(segId);
    }
  }

  for (const item of uniqueByText.values()) {
    missing.push(item);
  }

  if (missing.length === 0) {
    return { translations: resolved.map((item) => item.text), segments: resolved };
  }

  const userPrompt =
    `TARGET_LANGUAGE=${targetLanguage}\n` +
    missing.map((item) => `${item.id}\t${item.text}`).join("\n");

  const content = await performTranslateRequest(settings, userPrompt);
  let output = parseTaggedTranslations(content);
  if (output.length === 0) {
    try {
      const nested = JSON.parse(content);
      const nestedContent = extractAssistantContent(nested);
      output = parseTaggedTranslations(nestedContent);
    } catch {
      // keep best-effort fallback
    }
  }
  const byId = new Map();
  for (const item of output) {
    if (item && typeof item.id === "string" && typeof item.text === "string" && item.text.length > 0) {
      byId.set(item.id, item.text);
    }
  }

  for (let idx = 0; idx < missing.length; idx += 1) {
    const item = missing[idx];
    const sourceText = item.text;
    const translatedText = byId.get(item.id) || output[idx]?.text || sourceText;
    for (let j = 0; j < item.indexes.length; j += 1) {
      const targetIndex = item.indexes[j];
      const targetId = item.ids[j];
      resolved[targetIndex] = { id: targetId, text: translatedText };
    }
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

function runQueuedTask(task) {
  activeTasks += 1;
  translateBatch(task.payload)
    .then(task.resolve)
    .catch(task.reject)
    .finally(() => {
      activeTasks -= 1;
      runScheduler().catch(() => undefined);
    });
}

async function runScheduler() {
  if (schedulerRunning) {
    return;
  }
  schedulerRunning = true;

  try {
    while (queuedTasks.length > 0) {
      const settings = await getSettings();
      const parallel = Math.min(5, Math.max(1, Number.parseInt(String(settings.batchParallel || 2), 10) || 2));
      if (activeTasks >= parallel) {
        await sleep(50);
        continue;
      }

      const waitMs = Math.max(0, nextDispatchAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const task = queuedTasks.shift();
      if (!task) {
        continue;
      }

      nextDispatchAt = Date.now() + DISPATCH_GAP_MS;
      runQueuedTask(task);
    }
  } finally {
    schedulerRunning = false;
  }
}

function queueTranslateBatch(payload) {
  return new Promise((resolve, reject) => {
    queuedTasks.push({ payload, resolve, reject });
    runScheduler().catch(reject);
  });
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
