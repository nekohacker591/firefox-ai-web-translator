const STATE = {
  enabled: false,
  targetLanguage: "English",
  observer: null,
  processedNodes: new WeakMap(),
  originalText: new WeakMap(),
  translatedNodes: new Set(),
  pendingTimer: null,
  inFlight: false
};

const BATCH_SIZE = 30;
const MAX_TEXT_LENGTH = 600;

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "IFRAME",
  "TEXTAREA",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "SVG",
  "MATH"
]);

function isElementVisible(el) {
  if (!el || !el.isConnected) {
    return false;
  }

  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  return true;
}

function shouldTranslateNode(textNode) {
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return false;
  }

  const parent = textNode.parentElement;
  if (!parent || !parent.isConnected || SKIP_TAGS.has(parent.tagName)) {
    return false;
  }

  if (
    parent.closest(
      "[translate='no'], [contenteditable='true'], input, textarea, select, option"
    )
  ) {
    return false;
  }

  if (!isElementVisible(parent)) {
    return false;
  }

  const text = textNode.nodeValue;
  if (!text) {
    return false;
  }

  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_TEXT_LENGTH) {
    return false;
  }

  if (!/[\p{L}]/u.test(trimmed)) {
    return false;
  }

  return true;
}

function collectTextNodes(root = document.body) {
  if (!root) {
    return [];
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let current = walker.nextNode();

  while (current) {
    if (shouldTranslateNode(current)) {
      const lastTranslated = STATE.processedNodes.get(current);
      const text = current.nodeValue || "";
      if (lastTranslated !== text) {
        nodes.push(current);
      }
    }
    current = walker.nextNode();
  }

  return nodes;
}

async function translateNodes(nodes) {
  if (!nodes.length || STATE.inFlight) {
    return;
  }

  STATE.inFlight = true;

  try {
    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);
      const texts = batch.map((node) => node.nodeValue || "");

      const result = await browser.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        payload: {
          texts,
          targetLanguage: STATE.targetLanguage
        }
      });

      const translations = result?.translations || texts;

      for (let index = 0; index < batch.length; index += 1) {
        const node = batch[index];
        if (!node || !node.isConnected) {
          continue;
        }

        if (!STATE.originalText.has(node)) {
          STATE.originalText.set(node, texts[index]);
        }

        const translated = translations[index] || texts[index];
        node.nodeValue = translated;
        STATE.processedNodes.set(node, translated);
        STATE.translatedNodes.add(node);
      }
    }
  } catch (error) {
    console.warn("AI translation failed:", error);
  } finally {
    STATE.inFlight = false;
  }
}

function scheduleTranslation(root) {
  if (!STATE.enabled) {
    return;
  }

  if (STATE.pendingTimer) {
    window.clearTimeout(STATE.pendingTimer);
  }

  STATE.pendingTimer = window.setTimeout(async () => {
    const nodes = collectTextNodes(root || document.body);
    await translateNodes(nodes);
  }, 250);
}

function restoreOriginalText() {
  for (const node of STATE.translatedNodes) {
    if (node?.isConnected && STATE.originalText.has(node)) {
      node.nodeValue = STATE.originalText.get(node);
    }
  }

  STATE.translatedNodes.clear();
  STATE.processedNodes = new WeakMap();
}

function startObserver() {
  if (STATE.observer) {
    STATE.observer.disconnect();
  }

  STATE.observer = new MutationObserver((mutations) => {
    if (!STATE.enabled) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target?.parentElement) {
        scheduleTranslation(mutation.target.parentElement);
      } else if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        scheduleTranslation();
      }
    }
  });

  STATE.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });
}

function stopObserver() {
  if (STATE.observer) {
    STATE.observer.disconnect();
    STATE.observer = null;
  }
}

async function applySettings(settings) {
  const wasEnabled = STATE.enabled;

  STATE.enabled = Boolean(settings.enabled);
  STATE.targetLanguage = settings.targetLanguage || "English";

  if (STATE.enabled && !wasEnabled) {
    startObserver();
    scheduleTranslation();
  } else if (!STATE.enabled && wasEnabled) {
    stopObserver();
    restoreOriginalText();
  } else if (STATE.enabled && wasEnabled) {
    scheduleTranslation();
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "SETTINGS_UPDATED") {
    applySettings(message.payload || {});
  }
});

(async function init() {
  try {
    const settings = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });
    applySettings(settings || {});
  } catch (error) {
    console.warn("Unable to initialize translator settings.", error);
  }
})();
