const els = {
  toggleBtn: document.getElementById("toggleBtn"),
  alwaysTranslateBtn: document.getElementById("alwaysTranslateBtn"),
  targetLanguage: document.getElementById("targetLanguage"),
  modelSelect: document.getElementById("modelSelect"),
  apiKey: document.getElementById("apiKey"),
  systemPrompt: document.getElementById("systemPrompt"),
  status: document.getElementById("status")
};

let currentSettings = {
  enabled: false,
  targetLanguage: "English",
  model: "nova-fast",
  apiKey: "",
  systemPrompt: ""
};

function setStatus(message, timeout = 2200) {
  els.status.textContent = message;
  if (timeout > 0) {
    window.setTimeout(() => {
      if (els.status.textContent === message) {
        els.status.textContent = "";
      }
    }, timeout);
  }
}

function renderToggle(enabled) {
  els.toggleBtn.textContent = enabled ? "Translation ON" : "Translation OFF";
  els.toggleBtn.classList.toggle("on", enabled);
  els.toggleBtn.classList.toggle("off", !enabled);
}

function populateModels(models, currentModel) {
  els.modelSelect.innerHTML = "";

  const fallbackModels = ["nova-fast", "mistral", "openai-fast"];
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
  } else {
    els.modelSelect.value = "nova-fast";
  }
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs.find((tab) => tab.id && tab.url && !tab.url.startsWith("about:")) || null;
}

async function notifyActiveTab(payload) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }

  await browser.tabs
    .sendMessage(tab.id, { type: "SETTINGS_UPDATED", payload })
    .catch(() => null);
}

async function persistSettings(partial, statusMessage = "Saved") {
  const payload = {
    ...currentSettings,
    ...partial
  };

  const saved = await browser.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    payload
  });

  currentSettings = { ...saved };
  renderToggle(currentSettings.enabled);
  await notifyActiveTab(currentSettings);
  setStatus(statusMessage);
}

function wireAutoSave() {
  els.targetLanguage.addEventListener("change", () => {
    persistSettings(
      { targetLanguage: els.targetLanguage.value.trim() || "English" },
      "Language saved"
    ).catch((error) => setStatus(`Error: ${error.message}`, 5000));
  });

  els.modelSelect.addEventListener("change", () => {
    persistSettings({ model: els.modelSelect.value || "nova-fast" }, "Model saved").catch(
      (error) => setStatus(`Error: ${error.message}`, 5000)
    );
  });

  els.apiKey.addEventListener("change", () => {
    persistSettings({ apiKey: els.apiKey.value.trim() }, "API key saved").catch((error) =>
      setStatus(`Error: ${error.message}`, 5000)
    );
  });

  els.systemPrompt.addEventListener("change", () => {
    persistSettings({ systemPrompt: els.systemPrompt.value.trim() }, "Prompt saved").catch(
      (error) => setStatus(`Error: ${error.message}`, 5000)
    );
  });

  els.toggleBtn.addEventListener("click", () => {
    const enabled = !currentSettings.enabled;
    persistSettings(
      { enabled },
      enabled ? "Translation enabled" : "Translation disabled"
    ).catch((error) => setStatus(`Error: ${error.message}`, 5000));
  });

  els.alwaysTranslateBtn.addEventListener("click", async () => {
    try {
      const activeTab = await getActiveTab();
      if (!activeTab?.url) {
        setStatus("No active page to set", 3500);
        return;
      }

      const saved = await browser.runtime.sendMessage({
        type: "FORCE_TRANSLATE_FOR_URL",
        payload: { url: activeTab.url }
      });
      currentSettings = { ...saved };

      await browser.tabs
        .sendMessage(activeTab.id, { type: "FORCE_TRANSLATE_NOW" })
        .catch(() => null);
      setStatus("Always translate enabled for this site");
    } catch (error) {
      setStatus(`Error: ${error.message}`, 5000);
    }
  });
}

async function loadSettings() {
  const [settings, modelResult] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_SETTINGS" }),
    browser.runtime.sendMessage({ type: "LIST_MODELS" })
  ]);

  currentSettings = {
    ...currentSettings,
    ...(settings || {})
  };

  populateModels(modelResult?.models, currentSettings.model || "nova-fast");
  renderToggle(Boolean(currentSettings.enabled));

  els.targetLanguage.value = currentSettings.targetLanguage || "English";
  els.apiKey.value = currentSettings.apiKey || "";
  els.systemPrompt.value = currentSettings.systemPrompt || "";
}

document.addEventListener("DOMContentLoaded", () => {
  wireAutoSave();
  loadSettings().catch((error) => {
    console.error(error);
    setStatus(`Failed to load settings: ${error.message}`, 5000);
  });
});
