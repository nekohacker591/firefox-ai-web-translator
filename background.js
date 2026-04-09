const DEFAULT_SETTINGS = {
  enabled: false,
  targetLanguage: "English",
  model: "mistral",
  apiKey: "",
  systemPrompt:
    "You are an expert website translator. Detect the source language automatically for each text segment and translate into the target language only when needed. If text is already in the target language, keep it unchanged. Preserve meaning, tone, punctuation, emojis, placeholders, brand names, URLs, and code snippets."
};

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

async function translateBatch({ texts, targetLanguage }) {
  const settings = await getSettings();

  if (!settings.enabled) {
    return { translations: texts, skipped: true, reason: "disabled" };
  }

  if (!settings.apiKey) {
    return { translations: texts, skipped: true, reason: "missing_key" };
  }

  if (!Array.isArray(texts) || texts.length === 0) {
    return { translations: [] };
  }

  const userPrompt = JSON.stringify({
    targetLanguage,
    texts
  });

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
            "You will receive JSON: {targetLanguage, texts}. Detect language for each item independently. Translate only items not already in targetLanguage. Return only JSON in this exact format: {\"translations\":[string,...]} with same length and ordering."
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Translate request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
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

  const output = Array.isArray(parsed?.translations) ? parsed.translations : null;
  if (!output || output.length !== texts.length) {
    throw new Error("Translation response size mismatch.");
  }

  return {
    translations: output.map((value, index) =>
      typeof value === "string" ? value : texts[index]
    )
  };
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
    case "LIST_MODELS":
      return listModels().then((models) => ({ models }));
    case "TRANSLATE_BATCH":
      return translateBatch(message.payload || {});
    default:
      return undefined;
  }
});
