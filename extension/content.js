(() => {
  const VIEWED_KEY = "viewed";
  const SETTINGS_KEY = "searchSettings";
  const VIEWED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const ITEM_PATH_RE = /\/item\/[^/?#]*-(\d+)(?:[/?#]|$)/;
  const ITEM_LINK_SELECTOR = 'a[href*="/item/"]';
  const ITEMS_LIST_SELECTOR = '[aria-label="Items list"]';
  const RESERVED_BADGE_SELECTOR = 'wallapop-badge[badge-type="reserved"]';
  const MUTATION_DEBOUNCE_MS = 150;
  const DEFAULT_SETTINGS = {
    strictAllTokens: false,
    exactTextMatch: false
  };

  let viewedCache = [];
  let settingsCache = { ...DEFAULT_SETTINGS };
  let mutationTimer = null;
  let lastUrl = location.href;
  let extensionContextValid = true;

  const storage = {
    async getViewed() {
      const items = await getLocalStorage({ [VIEWED_KEY]: [] });
      return items[VIEWED_KEY];
    },

    async setViewed(viewed) {
      await setLocalStorage({ [VIEWED_KEY]: viewed });
    },

    async getSettings() {
      const items = await getLocalStorage({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      return normalizeSettings(items[SETTINGS_KEY]);
    }
  };

  function hasChromeStorageAccess() {
    return Boolean(
      extensionContextValid &&
      globalThis.chrome &&
      chrome.storage &&
      chrome.storage.local
    );
  }

  function isExtensionContextError(error) {
    return String(error && error.message || error).includes("Extension context invalidated");
  }

  function handleChromeApiError(error) {
    if (isExtensionContextError(error)) {
      extensionContextValid = false;
    }
  }

  function getRuntimeLastError() {
    try {
      return chrome.runtime && chrome.runtime.lastError;
    } catch (error) {
      handleChromeApiError(error);
      return error;
    }
  }

  function getLocalStorage(defaults) {
    return new Promise((resolve) => {
      if (!hasChromeStorageAccess()) {
        resolve(defaults);
        return;
      }

      try {
        chrome.storage.local.get(defaults, (items) => {
          const error = getRuntimeLastError();

          if (error) {
            handleChromeApiError(error);
            resolve(defaults);
            return;
          }

          resolve(items || defaults);
        });
      } catch (error) {
        handleChromeApiError(error);
        resolve(defaults);
      }
    });
  }

  function setLocalStorage(items) {
    return new Promise((resolve) => {
      if (!hasChromeStorageAccess()) {
        resolve(false);
        return;
      }

      try {
        chrome.storage.local.set(items, () => {
          const error = getRuntimeLastError();

          if (error) {
            handleChromeApiError(error);
            resolve(false);
            return;
          }

          resolve(true);
        });
      } catch (error) {
        handleChromeApiError(error);
        resolve(false);
      }
    });
  }

  function normalizeSettings(value) {
    return {
      ...DEFAULT_SETTINGS,
      ...(value && typeof value === "object" ? value : {})
    };
  }

  function normalizeViewed(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const now = Date.now();
    const byId = new Map();

    for (const item of value) {
      const id = typeof item === "string" ? item : item && item.id;
      const viewedAt = typeof item === "object" && Number.isFinite(item.viewedAt)
        ? item.viewedAt
        : now;

      if (!id || now - viewedAt > VIEWED_TTL_MS) {
        continue;
      }

      const previous = byId.get(id);
      if (!previous || previous.viewedAt < viewedAt) {
        byId.set(id, { id: String(id), viewedAt });
      }
    }

    return Array.from(byId.values()).sort((a, b) => b.viewedAt - a.viewedAt);
  }

  function viewedListsEqual(left, right) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => {
      const other = right[index];
      return other && item.id === other.id && item.viewedAt === other.viewedAt;
    });
  }

  function parseItemId(urlLike) {
    try {
      const url = new URL(urlLike, location.origin);
      const match = url.pathname.match(ITEM_PATH_RE);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function normalizeSearchText(value) {
    return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  }

  function getSearchQuery() {
    if (location.pathname !== "/search") {
      return "";
    }

    return new URLSearchParams(location.search).get("keywords") || "";
  }

  function getSearchTokens(query) {
    return normalizeSearchText(query)
      .split(" ")
      .filter(Boolean);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function titleContainsToken(title, token) {
    const tokenPattern = escapeRegExp(token);
    const tokenBoundary = "[^\\p{L}\\p{N}]";
    const matcher = new RegExp(`(^|${tokenBoundary})${tokenPattern}($|${tokenBoundary})`, "u");

    return matcher.test(title);
  }

  function titleContainsEveryToken(title, tokens) {
    return tokens.every((token) => titleContainsToken(title, token));
  }

  function titleMatchesSearch(title, query, tokens) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return true;
    }

    const normalizedTitle = normalizeSearchText(title);

    if (settingsCache.exactTextMatch) {
      return titleContainsEveryToken(normalizedTitle, tokens);
    }

    if (settingsCache.strictAllTokens) {
      return titleContainsEveryToken(normalizedTitle, tokens);
    }

    return tokens.some((token) => titleContainsToken(normalizedTitle, token));
  }

  function getItemLinks() {
    return Array.from(document.querySelectorAll(ITEM_LINK_SELECTOR))
      .filter((link) => parseItemId(link.href));
  }

  function getCardRoot(link) {
    const list = link.closest(ITEMS_LIST_SELECTOR);

    if (list) {
      let node = link;
      while (node.parentElement && node.parentElement !== list) {
        node = node.parentElement;
      }

      return node;
    }

    return link.closest("article, li") || link.parentElement || link;
  }

  function getCardTitle(card, link) {
    const explicitTitle = card.querySelector(
      'h1, h2, h3, [data-testid*="title" i], [class*="title" i]'
    );

    const candidates = [
      link.getAttribute("aria-label"),
      link.getAttribute("title"),
      explicitTitle && explicitTitle.textContent,
      link.textContent,
      card.textContent
    ];

    return candidates.find((value) => value && value.trim())?.trim() || "";
  }

  function getImageAnchor(card, link) {
    return (
      card.querySelector("picture") ||
      card.querySelector("img") ||
      link.querySelector("picture") ||
      link.querySelector("img") ||
      link
    );
  }

  function ensureEye(card, link) {
    if (card.querySelector(".vayabob-eye")) {
      return;
    }

    const anchor = getImageAnchor(card, link);
    const overlayParent = anchor.closest("a, picture, div") || card;

    overlayParent.classList.add("vayabob-viewed");
    overlayParent.insertAdjacentHTML(
      "beforeend",
      '<span class="vayabob-eye" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M2.2 12s3.6-6 9.8-6 9.8 6 9.8 6-3.6 6-9.8 6-9.8-6-9.8-6Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg></span>'
    );
  }

  function applySearchMarks() {
    const query = getSearchQuery();
    const tokens = getSearchTokens(query);
    const viewedIds = new Set(viewedCache.map((item) => item.id));

    for (const link of getItemLinks()) {
      const id = parseItemId(link.href);
      const card = getCardRoot(link);
      const title = getCardTitle(card, link);

      card.classList.toggle("vayabob-dimmed", !titleMatchesSearch(title, query, tokens));
      card.classList.toggle("vayabob-reserved", Boolean(card.querySelector(RESERVED_BADGE_SELECTOR)));

      if (viewedIds.has(id)) {
        ensureEye(card, link);
      }
    }
  }

  async function rememberCurrentItem() {
    const id = parseItemId(location.href);
    if (!id) {
      return;
    }

    const now = Date.now();
    const nextViewed = normalizeViewed([
      { id, viewedAt: now },
      ...viewedCache.filter((item) => item.id !== id)
    ]);

    viewedCache = nextViewed;
    await storage.setViewed(nextViewed);
  }

  async function handlePage() {
    const [storedViewed, storedSettings] = await Promise.all([
      storage.getViewed(),
      storage.getSettings()
    ]);

    viewedCache = normalizeViewed(storedViewed);
    settingsCache = storedSettings;

    if (!viewedListsEqual(viewedCache, Array.isArray(storedViewed) ? storedViewed : [])) {
      await storage.setViewed(viewedCache);
    }

    await rememberCurrentItem();
    applySearchMarks();
  }

  function scheduleHandlePage() {
    window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(runHandlePage, MUTATION_DEBOUNCE_MS);
  }

  function runHandlePage() {
    handlePage().catch((error) => {
      handleChromeApiError(error);
      applySearchMarks();
    });
  }

  function installSpaNavigationHook() {
    const notify = () => {
      window.dispatchEvent(new Event("vayabob:navigation"));
    };

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }

    window.addEventListener("popstate", notify);
    window.addEventListener("vayabob:navigation", () => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        scheduleHandlePage();
      }
    });
  }

  if (hasChromeStorageAccess()) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[SETTINGS_KEY]) {
        return;
      }

      settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
      applySearchMarks();
    });
  }

  installSpaNavigationHook();
  new MutationObserver(scheduleHandlePage).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  runHandlePage();
})();
