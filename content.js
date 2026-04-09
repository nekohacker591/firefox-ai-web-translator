const STATE = {
  enabled: false,
  targetLanguage: "English",
  observer: null,
  processedNodes: new WeakMap(),
  originalText: new WeakMap(),
  translatedNodes: new Set(),
  pendingTimer: null,
  inFlight: false,
  rescanRequested: false,
  applyingTranslations: false,
  forceTranslateForHost: false
};

const BATCH_SIZE = 120;
const MAX_TEXT_LENGTH = 600;
const MAX_BATCH_CHARS = 10000;
const TRANSLATE_DEBOUNCE_MS = 300;

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

const COMMON_TEXT_SELECTORS = [
  "main",
  "article",
  "section",
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "span",
  "div",
  "td",
  "th",
  "label",
  "small",
  "blockquote",
  "figcaption",
  ".message",
  ".comment",
  ".forum-post",
  ".thread-content",
  ".content",
  ".article",
  ".post",
  "[role='main']"
];

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

function isLikelyContentText(textNode) {
  const parent = textNode?.parentElement;
  if (!parent) {
    return false;
  }

  if (parent.closest("nav, header, footer, aside, menu")) {
    return false;
  }

  if (COMMON_TEXT_SELECTORS.some((selector) => parent.matches(selector) || parent.closest(selector))) {
    return true;
  }

  const text = (textNode.nodeValue || "").trim();
  return text.length > 3;
}

function looksMostlyEnglish(text) {
  const normalized = (text || "").toLowerCase().trim();
  if (!normalized) {
    return true;
  }

  if (/[^\u0000-\u00ff]/.test(normalized)) {
    return false;
  }

  const words = normalized.match(/[a-z']+/g) || [];
  if (words.length === 0) {
    return false;
  }

  const commonEnglishWords = new Set([
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
    "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
    "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
    "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
    "so", "up", "out", "if", "about", "who", "get", "which", "go", "me"
  ]);

  const englishHits = words.filter((word) => commonEnglishWords.has(word)).length;
  return englishHits / Math.max(words.length, 1) >= 0.1;
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
      if (!isLikelyContentText(current)) {
        current = walker.nextNode();
        continue;
      }

      const rawText = current.nodeValue || "";
      if (
        !STATE.forceTranslateForHost &&
        STATE.targetLanguage.toLowerCase() === "english" &&
        looksMostlyEnglish(rawText)
      ) {
        current = walker.nextNode();
        continue;
      }

      const lastTranslated = STATE.processedNodes.get(current);
      const text = rawText;
      if (lastTranslated !== text) {
        nodes.push(current);
      }
    }
    current = walker.nextNode();
  }

  return nodes;
}

async function translateNodes(nodes) {
  if (!nodes.length) {
    return;
  }

  if (STATE.inFlight) {
    STATE.rescanRequested = true;
    return;
  }

  STATE.inFlight = true;
  STATE.rescanRequested = false;
  STATE.applyingTranslations = true;

  try {
    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batchStart = i;
      const batch = [];
      let charCount = 0;
      let cursor = i;
      while (cursor < nodes.length && batch.length < BATCH_SIZE) {
        const candidate = nodes[cursor];
        const candidateText = candidate?.nodeValue || "";
        if (batch.length > 0 && charCount + candidateText.length > MAX_BATCH_CHARS) {
          break;
        }
        batch.push(candidate);
        charCount += candidateText.length;
        cursor += 1;
      }
      i = cursor - 1;

      const segments = batch.map((node, index) => ({
        id: `n${batchStart + index}`,
        text: node.nodeValue || ""
      }));
      const texts = segments.map((segment) => segment.text);

      const result = await browser.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        payload: {
          texts: { segments },
          targetLanguage: STATE.targetLanguage
        }
      });

      const translatedById = new Map(
        Array.isArray(result?.segments)
          ? result.segments
              .filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
              .map((item) => [item.id, item.text])
          : []
      );
      const translations = segments.map(
        (segment, index) => translatedById.get(segment.id) || result?.translations?.[index] || texts[index]
      );

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
    STATE.applyingTranslations = false;
    if (STATE.rescanRequested) {
      scheduleTranslation();
    }
  }
}

function scheduleTranslation(root) {
  if (!STATE.enabled || document.visibilityState !== "visible" || !document.hasFocus()) {
    return;
  }

  if (STATE.pendingTimer) {
    window.clearTimeout(STATE.pendingTimer);
  }

  STATE.pendingTimer = window.setTimeout(async () => {
    const nodes = collectTextNodes(root || document.body);
    await translateNodes(nodes);
  }, TRANSLATE_DEBOUNCE_MS);
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

    if (STATE.applyingTranslations) {
      STATE.rescanRequested = true;
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
  const hostname = window.location.hostname;
  STATE.forceTranslateForHost = (settings.forceTranslateHosts || []).includes(hostname);

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
  } else if (message?.type === "FORCE_TRANSLATE_NOW") {
    STATE.forceTranslateForHost = true;
    scheduleTranslation();
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

window.addEventListener("focus", () => {
  if (STATE.enabled) {
    scheduleTranslation();
  }
});
