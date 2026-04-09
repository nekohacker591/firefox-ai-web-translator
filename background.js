const POLLINATIONS_BASE = "https://gen.pollinations.ai/v1";
const DEFAULT_MODEL = "openai";
const DEFAULT_PROMPT = `You are an expert website translator.
Translate user-provided webpage text snippets into the target language while preserving intent, tone, and context.
Rules:
1) Automatically detect the source language.
2) Keep UI text concise and natural for native speakers.
3) Preserve placeholders, variables, URLs, HTML entities, and numbers.
4) Do not add explanations.
5) Return ONLY valid JSON in this exact format:
{
  "source_language": "<detected language name>",
  "translations": [{"id":"<id>","text":"<translated text>"}]
}`;

const DEFAULT_SETTINGS = {
  enabled: true,
  targetLanguage: "English",
  model: DEFAULT_MODEL,
  apiKey: "",
  systemPrompt: DEFAULT_PROMPT
};

async function getSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function translateBatch({ items, targetLanguage, model, apiKey, systemPrompt }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { sourceLanguage: "unknown", translations: [] };
  }

  const payload = {
    model: model || DEFAULT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt || DEFAULT_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          target_language: targetLanguage,
          snippets: items.map((item) => ({ id: item.id, text: item.text }))
        })
      }
    ]
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${POLLINATIONS_BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Translation API error (${response.status}): ${text}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("No translation content returned from API.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model did not return valid JSON translation output.");
  }

  const translationMap = new Map(
    (parsed.translations || []).map((entry) => [String(entry.id), String(entry.text || "")])
  );

  return {
    sourceLanguage: parsed.source_language || "unknown",
    translations: items.map((item) => ({
      id: item.id,
      text: translationMap.get(String(item.id)) || item.text
    }))
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "translator:get-settings") {
    return getSettings();
  }

  if (message?.type === "translator:set-settings") {
    return browser.storage.local.set(message.settings || {});
  }

  if (message?.type === "translator:translate") {
    return (async () => {
      const settings = await getSettings();
      return translateBatch({
        items: message.items || [],
        targetLanguage: message.targetLanguage || settings.targetLanguage,
        model: message.model || settings.model,
        apiKey: settings.apiKey,
        systemPrompt: settings.systemPrompt
      });
    })();
  }

  if (message?.type === "translator:fetch-models") {
    return (async () => {
      const res = await fetch(`${POLLINATIONS_BASE}/models`);
      if (!res.ok) {
        throw new Error(`Unable to fetch models (${res.status}).`);
      }
      const data = await res.json();
      return data?.data || [];
    })();
  }

  return undefined;
});
