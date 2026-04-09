const FALLBACK_MODELS = ["openai", "openai-fast", "openai-large", "qwen-coder", "mistral", "gemini-fast"];

const DEFAULT_PROMPT = `You are an expert website translator.
Translate webpage snippets into the requested target language.
Detect the source language automatically.
Preserve meaning, tone, and formatting placeholders.
Return only valid JSON with source_language and translations [{id,text}].`;

async function loadSettings() {
  const settings = await browser.runtime.sendMessage({ type: "translator:get-settings" });
  document.getElementById("enabled").checked = !!settings.enabled;
  document.getElementById("targetLanguage").value = settings.targetLanguage || "English";
  document.getElementById("apiKey").value = settings.apiKey || "";
  document.getElementById("systemPrompt").value = settings.systemPrompt || DEFAULT_PROMPT;
  return settings;
}

function populateModels(models, selectedModel) {
  const modelEl = document.getElementById("model");
  modelEl.innerHTML = "";
  const finalModels = models.length ? models : FALLBACK_MODELS.map((id) => ({ id }));

  for (const model of finalModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    if (model.id === selectedModel) {
      option.selected = true;
    }
    modelEl.appendChild(option);
  }
}

async function loadModels(selectedModel) {
  try {
    const models = await browser.runtime.sendMessage({ type: "translator:fetch-models" });
    populateModels(models, selectedModel);
  } catch {
    populateModels([], selectedModel);
  }
}

async function saveSettings() {
  const settings = {
    enabled: document.getElementById("enabled").checked,
    targetLanguage: document.getElementById("targetLanguage").value.trim() || "English",
    model: document.getElementById("model").value,
    apiKey: document.getElementById("apiKey").value.trim(),
    systemPrompt: document.getElementById("systemPrompt").value.trim() || DEFAULT_PROMPT
  };

  await browser.runtime.sendMessage({
    type: "translator:set-settings",
    settings
  });

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    browser.tabs.sendMessage(tab.id, { type: "translator:refresh" }).catch(() => {});
  }

  document.getElementById("status").textContent = "Saved.";
}

(async function init() {
  const settings = await loadSettings();
  await loadModels(settings.model);
  document.getElementById("save").addEventListener("click", saveSettings);
})();
