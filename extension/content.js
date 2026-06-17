(() => {
  const VIEWED_KEY = "viewed";
  const TRASH_KEY = "trash";
  const SETTINGS_KEY = "searchSettings";
  const VIEWED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const TRASH_TTL_MS = VIEWED_TTL_MS;
  const ITEM_PATH_RE = /\/item\/[^/?#]*-(\d+)(?:[/?#]|$)/;
  const ITEM_LINK_SELECTOR = 'a[href*="/item/"]';
  const ITEMS_LIST_SELECTOR = '[aria-label="Items list"]';
  const RESERVED_BADGE_SELECTOR = 'wallapop-badge[badge-type="reserved"]';
  const TRASH_BUTTON_CLASS = "vayabob-trash-button";
  const TRASH_BUTTON_FLOATING_CLASS = "vayabob-trash-button-floating";
  const TRASHED_TITLE_CLASS = "vayabob-trash-title";
  const TRASH_BUTTON_GAP = 8;
  const MUTATION_DEBOUNCE_MS = 150;
  const DEFAULT_SETTINGS = {
    strictAllTokens: false,
    exactTextMatch: false
  };

  let viewedCache = [];
  let trashCache = [];
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

    async getTrash() {
      const items = await getLocalStorage({ [TRASH_KEY]: [] });
      return items[TRASH_KEY];
    },

    async setTrash(trash) {
      await setLocalStorage({ [TRASH_KEY]: trash });
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

  function normalizeTimedItems(value, timestampKey, ttlMs) {
    if (!Array.isArray(value)) {
      return [];
    }

    const now = Date.now();
    const byId = new Map();

    for (const item of value) {
      const id = typeof item === "string" ? item : item && item.id;
      const timestamp = typeof item === "object" && Number.isFinite(item[timestampKey])
        ? item[timestampKey]
        : now;

      if (!id || now - timestamp > ttlMs) {
        continue;
      }

      const previous = byId.get(id);
      if (!previous || previous[timestampKey] < timestamp) {
        byId.set(id, { id: String(id), [timestampKey]: timestamp });
      }
    }

    return Array.from(byId.values()).sort((a, b) => b[timestampKey] - a[timestampKey]);
  }

  function normalizeViewed(value) {
    return normalizeTimedItems(value, "viewedAt", VIEWED_TTL_MS);
  }

  function normalizeTrash(value) {
    return normalizeTimedItems(value, "trashedAt", TRASH_TTL_MS);
  }

  function timedItemListsEqual(left, right, timestampKey) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => {
      const other = right[index];
      return other && item.id === other.id && item[timestampKey] === other[timestampKey];
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

  function getTextTokens(value) {
    return normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) || [];
  }

  function getSearchQuery() {
    if (location.pathname !== "/search") {
      return "";
    }

    return new URLSearchParams(location.search).get("keywords") || "";
  }

  function getSearchTokens(query) {
    return getTextTokens(query);
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

  function tokensMatchExactly(left, right) {
    if (left.length !== right.length) {
      return false;
    }

    const counts = new Map();

    for (const token of left) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }

    for (const token of right) {
      const count = counts.get(token);

      if (!count) {
        return false;
      }

      if (count === 1) {
        counts.delete(token);
      } else {
        counts.set(token, count - 1);
      }
    }

    return counts.size === 0;
  }

  function titleMatchesSearch(title, query, tokens) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return true;
    }

    const normalizedTitle = normalizeSearchText(title);

    if (settingsCache.exactTextMatch) {
      return tokensMatchExactly(getTextTokens(normalizedTitle), tokens);
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

  function getCardTitleElement(card, link) {
    return (
      card.querySelector('h1, h2, h3, [data-testid*="title" i], [class*="title" i]') ||
      link.querySelector('h1, h2, h3, [data-testid*="title" i], [class*="title" i]') ||
      null
    );
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

  function applyTrashMark(card, link, isTrashed) {
    card.classList.toggle("vayabob-trash", isTrashed);

    const titleElement = getCardTitleElement(card, link);

    if (titleElement) {
      titleElement.classList.toggle(TRASHED_TITLE_CLASS, isTrashed);
      card.classList.remove("vayabob-trash-title-fallback");
      return;
    }

    card.classList.toggle("vayabob-trash-title-fallback", isTrashed);
  }

  function applySearchMarks() {
    const query = getSearchQuery();
    const tokens = getSearchTokens(query);
    const viewedIds = new Set(viewedCache.map((item) => item.id));
    const trashIds = new Set(trashCache.map((item) => item.id));

    for (const link of getItemLinks()) {
      const id = parseItemId(link.href);
      const card = getCardRoot(link);
      const title = getCardTitle(card, link);

      card.classList.toggle("vayabob-dimmed", !titleMatchesSearch(title, query, tokens));
      card.classList.toggle("vayabob-reserved", Boolean(card.querySelector(RESERVED_BADGE_SELECTOR)));

      if (viewedIds.has(id)) {
        ensureEye(card, link);
      }

      applyTrashMark(card, link, trashIds.has(id));
    }
  }

  function isFavoriteControl(element) {
    const text = [
      element.getAttribute("aria-label"),
      element.getAttribute("text"),
      element.getAttribute("title"),
      element.textContent
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    const icon = [
      element.getAttribute("icon"),
      element.querySelector("walla-icon")?.getAttribute("icon")
    ].filter(Boolean).join(" ");

    return (
      text.includes("favorit") ||
      text.includes("favorite") ||
      text.includes("guardar como favorito") ||
      text.includes("save as favorite") ||
      icon.includes("heart")
    );
  }

  function getFavoriteControl() {
    return Array.from(document.querySelectorAll("button, walla-button"))
      .find(isFavoriteControl) || null;
  }

  function getItemTitleRow() {
    const title = document.querySelector(
      '[data-testid="item-detail__content"] h1, [class*="ItemDetailTwoColumns__title" i], main h1'
    );

    if (!title) {
      return null;
    }

    return title.closest(".d-flex") || title.parentElement;
  }

  function createTrashButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = TRASH_BUTTON_CLASS;
    button.setAttribute("aria-label", "Mark as trash");
    button.title = "Mark as trash";
    button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 6V4h8v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 6l1 15h10l1-15" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCurrentItemTrash().catch(handleChromeApiError);
    });

    return button;
  }

  function resetTrashButtonPosition(button) {
    button.classList.remove(TRASH_BUTTON_FLOATING_CLASS);
    button.style.left = "";
    button.style.top = "";
  }

  function positionTrashButton() {
    const button = document.querySelector(`.${TRASH_BUTTON_CLASS}`);
    const favoriteControl = getFavoriteControl();

    if (!button || !favoriteControl || !document.body.contains(favoriteControl)) {
      return;
    }

    if (button.parentElement !== document.body) {
      document.body.append(button);
    }

    const favoriteRect = favoriteControl.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const buttonWidth = buttonRect.width || 40;
    const buttonHeight = buttonRect.height || 40;

    button.classList.add(TRASH_BUTTON_FLOATING_CLASS);
    button.style.left = `${favoriteRect.left + window.scrollX - buttonWidth - TRASH_BUTTON_GAP}px`;
    button.style.top = `${favoriteRect.top + window.scrollY + ((favoriteRect.height - buttonHeight) / 2)}px`;
  }

  function syncTrashButtonState() {
    const id = parseItemId(location.href);
    const isTrashed = Boolean(id && trashCache.some((item) => item.id === id));

    for (const button of document.querySelectorAll(`.${TRASH_BUTTON_CLASS}`)) {
      button.classList.toggle("vayabob-trash-button-active", isTrashed);
      button.setAttribute("aria-pressed", String(isTrashed));
      button.setAttribute("aria-label", isTrashed ? "Remove trash mark" : "Mark as trash");
      button.title = isTrashed ? "Remove trash mark" : "Mark as trash";
    }
  }

  function ensureTrashButton() {
    const id = parseItemId(location.href);
    if (!id) {
      for (const button of document.querySelectorAll(`.${TRASH_BUTTON_CLASS}`)) {
        button.remove();
      }
      return;
    }

    const favoriteControl = getFavoriteControl();
    let button = document.querySelector(`.${TRASH_BUTTON_CLASS}`);

    if (!button) {
      button = createTrashButton();
    }

    if (favoriteControl && favoriteControl.parentElement) {
      if (button.parentElement !== document.body) {
        document.body.append(button);
      }
      positionTrashButton();
    } else {
      const titleRow = getItemTitleRow();
      if (!titleRow) {
        button.remove();
        return;
      }

      titleRow.classList.add("vayabob-item-title-row");
      resetTrashButtonPosition(button);
      if (button.parentElement !== titleRow) {
        titleRow.append(button);
      }
    }

    syncTrashButtonState();
  }

  async function toggleCurrentItemTrash() {
    const id = parseItemId(location.href);
    if (!id) {
      return;
    }

    const now = Date.now();
    const isTrashed = trashCache.some((item) => item.id === id);
    const nextTrash = isTrashed
      ? normalizeTrash(trashCache.filter((item) => item.id !== id))
      : normalizeTrash([
        { id, trashedAt: now },
        ...trashCache.filter((item) => item.id !== id)
      ]);

    trashCache = nextTrash;
    syncTrashButtonState();
    applySearchMarks();
    await storage.setTrash(nextTrash);
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
    const [storedViewed, storedTrash, storedSettings] = await Promise.all([
      storage.getViewed(),
      storage.getTrash(),
      storage.getSettings()
    ]);

    viewedCache = normalizeViewed(storedViewed);
    trashCache = normalizeTrash(storedTrash);
    settingsCache = storedSettings;

    if (!timedItemListsEqual(viewedCache, Array.isArray(storedViewed) ? storedViewed : [], "viewedAt")) {
      await storage.setViewed(viewedCache);
    }

    if (!timedItemListsEqual(trashCache, Array.isArray(storedTrash) ? storedTrash : [], "trashedAt")) {
      await storage.setTrash(trashCache);
    }

    await rememberCurrentItem();
    ensureTrashButton();
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
      if (areaName !== "local") {
        return;
      }

      if (changes[SETTINGS_KEY]) {
        settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
        applySearchMarks();
      }

      if (changes[TRASH_KEY]) {
        trashCache = normalizeTrash(changes[TRASH_KEY].newValue);
        syncTrashButtonState();
        applySearchMarks();
      }
    });
  }

  installSpaNavigationHook();
  window.addEventListener("resize", positionTrashButton);
  window.addEventListener("scroll", positionTrashButton, true);
  new MutationObserver(scheduleHandlePage).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  runHandlePage();
})();
