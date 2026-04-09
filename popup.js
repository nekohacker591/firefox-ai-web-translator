const els = {
  enabled: document.getElementById("enabled"),
  targetLanguage: document.getElementById("targetLanguage"),
  modelSelect: document.getElementById("modelSelect"),
  apiKey: document.getElementById("apiKey"),
  systemPrompt: document.getElementById("systemPrompt"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status")
};

function setStatus(message, timeout = 2500) {
  els.status.textContent = message;
  if (timeout > 0) {
    window.setTimeout(() => {
      if (els.status.textContent === message) {
        els.status.textContent = "";
      }
    }, timeout);
  }
}

function populateModels(models, currentModel) {
  els.modelSelect.innerHTML = "";

  const fallbackModels = ["mistral", "openai", "openai-fast"];
  const safeModels = Array.isArray(models) && models.length > 0 ? models : fallbackModels;
  const uniqueModels = Array.from(new Set(safeModels));
  uniqueModels.forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    els.modelSelect.appendChild(option);
  });

  if (currentModel && uniqueModels.includes(currentModel)) {
    els.modelSelect.value = currentModel;
  }
}

async function loadSettings() {
  const [settings, modelResult] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_SETTINGS" }),
    browser.runtime.sendMessage({ type: "LIST_MODELS" })
  ]);

  els.enabled.checked = Boolean(settings.enabled);
  els.targetLanguage.value = settings.targetLanguage || "English";
  els.apiKey.value = settings.apiKey || "";
  els.systemPrompt.value = settings.systemPrompt || "";

  populateModels(modelResult?.models, settings.model || "mistral");
}

async function notifyAllTabs(payload) {
  const tabs = await browser.tabs.query({});

  await Promise.all(
    tabs
      .filter((tab) => tab.id && tab.url && !tab.url.startsWith("about:"))
      .map((tab) =>
        browser.tabs
          .sendMessage(tab.id, { type: "SETTINGS_UPDATED", payload })
          .catch(() => null)
      )
  );
}

async function save() {
  const payload = {
    enabled: els.enabled.checked,
    targetLanguage: els.targetLanguage.value.trim() || "English",
    model: els.modelSelect.value || "mistral",
    apiKey: els.apiKey.value.trim(),
    systemPrompt: els.systemPrompt.value.trim()
  };

  const settings = await browser.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    payload
  });

  await notifyAllTabs(settings);
  setStatus("Saved.");
}

els.saveBtn.addEventListener("click", () => {
  save().catch((error) => {
    console.error(error);
    setStatus(`Error: ${error.message}`, 5000);
  });
});

document.addEventListener("DOMContentLoaded", () => {
  loadSettings().catch((error) => {
    console.error(error);
    setStatus(`Failed to load settings: ${error.message}`, 5000);
  });
});
