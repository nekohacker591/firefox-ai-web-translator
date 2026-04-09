const BATCH_SIZE = 30;
const MIN_TEXT_LENGTH = 2;
const translatedNodes = new WeakMap();
const translatedAttributes = new WeakMap();
let observer = null;
let translating = false;
let lastRun = 0;

function shouldSkipNode(node) {
  if (!node || !node.parentElement) {
    return true;
  }

  const tag = node.parentElement.tagName;
  if (["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "SVG"].includes(tag)) {
    return true;
  }

  if (node.parentElement.closest("[translate='no'], [data-no-translate], .notranslate")) {
    return true;
  }

  const value = (node.nodeValue || "").trim();
  if (value.length < MIN_TEXT_LENGTH) {
    return true;
  }

  if (!/[\p{L}\p{N}]/u.test(value)) {
    return true;
  }

  return false;
}

function collectTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const items = [];
  let current;
  while ((current = walker.nextNode())) {
    if (!shouldSkipNode(current)) {
      items.push({ node: current, text: current.nodeValue.trim() });
    }
  }
  return items;
}

function collectAttributes() {
  const items = [];
  const selectors = "img[alt], input[placeholder], textarea[placeholder], [title]";
  for (const el of document.querySelectorAll(selectors)) {
    if (el.closest("[translate='no'], [data-no-translate], .notranslate")) {
      continue;
    }

    for (const attr of ["alt", "placeholder", "title"]) {
      if (!el.hasAttribute(attr)) continue;
      const value = (el.getAttribute(attr) || "").trim();
      if (value.length < MIN_TEXT_LENGTH || !/[\p{L}\p{N}]/u.test(value)) continue;
      items.push({ el, attr, text: value });
    }
  }
  return items;
}

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function createIds(items, prefix) {
  return items.map((item, idx) => ({ ...item, id: `${prefix}-${idx}` }));
}

async function runTranslation() {
  const settings = await browser.runtime.sendMessage({ type: "translator:get-settings" });
  if (!settings.enabled || translating || !document.body) {
    if (!settings.enabled) restoreOriginals();
    return;
  }

  translating = true;
  try {
    const nodes = createIds(collectTextNodes(), "node");
    const attrs = createIds(collectAttributes(), "attr");
    const allItems = [
      ...nodes.map((x) => ({ id: x.id, text: x.text })),
      ...attrs.map((x) => ({ id: x.id, text: x.text }))
    ];

    const batches = chunk(allItems, BATCH_SIZE);
    const translatedMap = new Map();

    for (const batch of batches) {
      const response = await browser.runtime.sendMessage({
        type: "translator:translate",
        items: batch,
        targetLanguage: settings.targetLanguage,
        model: settings.model
      });

      for (const tr of response.translations || []) {
        translatedMap.set(tr.id, tr.text);
      }
    }

    for (const nodeItem of nodes) {
      const translated = translatedMap.get(nodeItem.id);
      if (!translated || translated === nodeItem.text) continue;
      if (!translatedNodes.has(nodeItem.node)) {
        translatedNodes.set(nodeItem.node, nodeItem.node.nodeValue);
      }
      nodeItem.node.nodeValue = nodeItem.node.nodeValue.replace(nodeItem.text, translated);
    }

    for (const attrItem of attrs) {
      const translated = translatedMap.get(attrItem.id);
      if (!translated || translated === attrItem.text) continue;
      if (!translatedAttributes.has(attrItem.el)) {
        translatedAttributes.set(attrItem.el, {});
      }
      const original = translatedAttributes.get(attrItem.el);
      if (!(attrItem.attr in original)) {
        original[attrItem.attr] = attrItem.el.getAttribute(attrItem.attr);
      }
      attrItem.el.setAttribute(attrItem.attr, translated);
    }

    lastRun = Date.now();
  } catch (error) {
    console.error("AI translator failed", error);
  } finally {
    translating = false;
  }
}

function restoreOriginals() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let current;
  while ((current = walker.nextNode())) {
    if (translatedNodes.has(current)) {
      current.nodeValue = translatedNodes.get(current);
      translatedNodes.delete(current);
    }
  }

  for (const el of document.querySelectorAll("[alt], [placeholder], [title]")) {
    if (!translatedAttributes.has(el)) continue;
    const original = translatedAttributes.get(el);
    Object.entries(original).forEach(([attr, value]) => {
      if (value == null) {
        el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, value);
      }
    });
    translatedAttributes.delete(el);
  }
}

function setupObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastRun > 2000) {
      runTranslation();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.enabled || changes.targetLanguage || changes.model || changes.systemPrompt) {
    runTranslation();
  }
});

setupObserver();
runTranslation();


browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "translator:refresh") {
    runTranslation();
  }
});
