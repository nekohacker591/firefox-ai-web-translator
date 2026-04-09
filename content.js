const STATE = {
  enabled: false,
  targetLanguage: "English",
  observer: null,
  processedNodes: new WeakMap(),
  nodeRetryCounts: new WeakMap(),
  originalText: new WeakMap(),
  translatedNodes: new Set(),
  pendingTimer: null,
  inFlight: false,
  rescanRequested: false,
  applyingTranslations: false,
  forceTranslateForHost: false,
  progressContainer: null,
  progressFill: null,
  hideProgressTimer: null,
  rescanIntervalId: null,
  sessionId: 0,
  showProgressBar: true
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

function containsNonLatinScript(text) {
  if (!text) {
    return false;
  }

  return (
    /[\u0400-\u04FF]/.test(text) || // Cyrillic
    /[\u0600-\u06FF]/.test(text) || // Arabic
    /[\u0590-\u05FF]/.test(text) || // Hebrew
    /[\u3040-\u30FF]/.test(text) || // Japanese Kana
    /[\u4E00-\u9FFF]/.test(text) || // CJK Unified Ideographs
    /[\uAC00-\uD7AF]/.test(text) || // Korean Hangul
    /[\u0900-\u097F]/.test(text) || // Devanagari
    /[\u0E00-\u0E7F]/.test(text) || // Thai
    /[\u0E80-\u0EFF]/.test(text) // Lao
  );
}

function collectTextNodesFromRoot(root, outNodes) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let current = walker.nextNode();

  while (current) {
    if (shouldTranslateNode(current)) {
      const rawText = current.nodeValue || "";
      const hasNonLatin = containsNonLatinScript(rawText);

      if (
        !STATE.forceTranslateForHost &&
        STATE.targetLanguage.toLowerCase() === "english" &&
        !hasNonLatin &&
        looksMostlyEnglish(rawText)
      ) {
        current = walker.nextNode();
        continue;
      }

      const lastTranslated = STATE.processedNodes.get(current);
      const text = rawText;
      const alreadyTranslatedForTarget =
        lastTranslated &&
        lastTranslated.targetLanguage === STATE.targetLanguage &&
        lastTranslated.text === text;
      if (!alreadyTranslatedForTarget) {
        outNodes.push(current);
      }
    }
    current = walker.nextNode();
  }
}

function getTraversalRoots(root = document.body) {
  const roots = [];
  if (!root) {
    return roots;
  }

  roots.push(root);
  const elements = root.querySelectorAll("*");
  for (const el of elements) {
    if (el.shadowRoot) {
      roots.push(el.shadowRoot);
    }
  }

  return roots;
}

function collectTextNodes(root = document.body) {
  const nodes = [];
  for (const traversalRoot of getTraversalRoots(root)) {
    collectTextNodesFromRoot(traversalRoot, nodes);
  }
  return nodes;
}

function shouldMarkAsTranslated(sourceText, translatedText) {
  if (translatedText !== sourceText) {
    return true;
  }

  const targetIsEnglish = STATE.targetLanguage.toLowerCase() === "english";
  if (targetIsEnglish && containsNonLatinScript(sourceText)) {
    return false;
  }

  return true;
}

function getConnectedTranslatedCount() {
  let count = 0;
  for (const node of STATE.translatedNodes) {
    if (!node?.isConnected) {
      continue;
    }
    const meta = STATE.processedNodes.get(node);
    if (meta && meta.targetLanguage === STATE.targetLanguage && meta.text === node.nodeValue) {
      count += 1;
    }
  }
  return count;
}

function ensureProgressBar() {
  if (!STATE.showProgressBar) {
    return;
  }

  if (STATE.progressContainer && STATE.progressFill) {
    return;
  }

  const container = document.createElement("div");
  container.id = "ai-web-translator-progress";
  container.style.position = "fixed";
  container.style.top = "0";
  container.style.left = "0";
  container.style.width = "100%";
  container.style.height = "3px";
  container.style.background = "rgba(0,0,0,0.1)";
  container.style.zIndex = "2147483647";
  container.style.pointerEvents = "none";
  container.style.opacity = "0";
  container.style.transition = "opacity 120ms ease";

  const fill = document.createElement("div");
  fill.style.height = "100%";
  fill.style.width = "0%";
  fill.style.background = "#26b34a";
  fill.style.transition = "width 140ms linear";

  container.appendChild(fill);
  document.documentElement.appendChild(container);

  STATE.progressContainer = container;
  STATE.progressFill = fill;
}

function updateProgressBar(pendingCount) {
  if (!STATE.showProgressBar) {
    if (STATE.progressContainer) {
      STATE.progressContainer.style.opacity = "0";
    }
    return;
  }

  ensureProgressBar();
  if (!STATE.progressContainer || !STATE.progressFill || !STATE.enabled) {
    return;
  }

  const completed = getConnectedTranslatedCount();
  const total = completed + Math.max(0, pendingCount);
  const ratio = total > 0 ? Math.min(1, completed / total) : 1;

  STATE.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  STATE.progressContainer.style.opacity = total > 0 ? "1" : "0";

  if (STATE.hideProgressTimer) {
    window.clearTimeout(STATE.hideProgressTimer);
    STATE.hideProgressTimer = null;
  }

  if (pendingCount === 0) {
    STATE.hideProgressTimer = window.setTimeout(() => {
      if (STATE.progressContainer) {
        STATE.progressContainer.style.opacity = "0";
      }
    }, 1200);
  }
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
  const runSessionId = STATE.sessionId;

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

      if (runSessionId !== STATE.sessionId) {
        return;
      }

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
        if (shouldMarkAsTranslated(texts[index], translated)) {
          STATE.nodeRetryCounts.set(node, 0);
          STATE.processedNodes.set(node, {
            text: translated,
            targetLanguage: STATE.targetLanguage
          });
          STATE.translatedNodes.add(node);
        } else {
          const retries = (STATE.nodeRetryCounts.get(node) || 0) + 1;
          STATE.nodeRetryCounts.set(node, retries);
        }
      }

      const remaining = Math.max(0, nodes.length - (i + batch.length));
      updateProgressBar(remaining);
    }
  } catch (error) {
    console.warn("AI translation failed:", error);
  } finally {
    STATE.inFlight = false;
    STATE.applyingTranslations = false;
    if (STATE.rescanRequested) {
      scheduleTranslation();
    } else if (runSessionId === STATE.sessionId && STATE.enabled) {
      const remaining = collectTextNodes(document.body).length;
      updateProgressBar(remaining);
    }
  }
}

function scheduleTranslation(root) {
  if (!STATE.enabled || document.visibilityState !== "visible") {
    return;
  }

  if (STATE.pendingTimer) {
    window.clearTimeout(STATE.pendingTimer);
  }

  STATE.pendingTimer = window.setTimeout(async () => {
    const nodes = collectTextNodes(root || document.body);
    updateProgressBar(nodes.length);
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
  STATE.nodeRetryCounts = new WeakMap();
  updateProgressBar(0);
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

function startAggressiveRescan() {
  if (STATE.rescanIntervalId) {
    window.clearInterval(STATE.rescanIntervalId);
  }

  STATE.rescanIntervalId = window.setInterval(() => {
    if (STATE.enabled && document.visibilityState === "visible") {
      scheduleTranslation();
    }
  }, 1000);
}

function stopAggressiveRescan() {
  if (STATE.rescanIntervalId) {
    window.clearInterval(STATE.rescanIntervalId);
    STATE.rescanIntervalId = null;
  }
}

function bumpSession() {
  STATE.sessionId += 1;
}

async function applySettings(settings) {
  const wasEnabled = STATE.enabled;

  STATE.enabled = Boolean(settings.enabled);
  STATE.targetLanguage = settings.targetLanguage || "English";
  STATE.showProgressBar = settings.showProgressBar !== false;
  const hostname = window.location.hostname;
  STATE.forceTranslateForHost = (settings.forceTranslateHosts || []).includes(hostname);

  if (STATE.enabled && !wasEnabled) {
    bumpSession();
    startObserver();
    startAggressiveRescan();
    scheduleTranslation();
  } else if (!STATE.enabled && wasEnabled) {
    bumpSession();
    stopObserver();
    stopAggressiveRescan();
    restoreOriginalText();
    if (STATE.progressContainer) {
      STATE.progressContainer.style.opacity = "0";
    }
  } else if (STATE.enabled && wasEnabled) {
    bumpSession();
    scheduleTranslation();
  }

  if (!STATE.showProgressBar && STATE.progressContainer) {
    STATE.progressContainer.style.opacity = "0";
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

window.addEventListener("beforeunload", () => {
  bumpSession();
  stopObserver();
  stopAggressiveRescan();
});

window.addEventListener("pagehide", () => {
  bumpSession();
});
