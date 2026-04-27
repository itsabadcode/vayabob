const SETTINGS_KEY = "searchSettings";
const DEFAULT_SETTINGS = {
  strictAllTokens: false,
  exactTextMatch: false
};

const strictAllTokensInput = document.querySelector("#strict-all-tokens");
const exactTextMatchInput = document.querySelector("#exact-text-match");

function normalizeSettings(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === "object" ? value : {})
  };
}

function getRuntimeLastError() {
  try {
    return chrome.runtime && chrome.runtime.lastError;
  } catch (error) {
    return error;
  }
}

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (items) => {
        if (getRuntimeLastError()) {
          resolve(DEFAULT_SETTINGS);
          return;
        }

        resolve(normalizeSettings(items[SETTINGS_KEY]));
      });
    } catch {
      resolve(DEFAULT_SETTINGS);
    }
  });
}

function setSettings(settings) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(settings) }, () => {
        getRuntimeLastError();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function render(settings) {
  strictAllTokensInput.checked = settings.strictAllTokens;
  exactTextMatchInput.checked = settings.exactTextMatch;
}

async function saveCurrentSettings() {
  await setSettings({
    strictAllTokens: strictAllTokensInput.checked,
    exactTextMatch: exactTextMatchInput.checked
  });
}

strictAllTokensInput.addEventListener("change", saveCurrentSettings);
exactTextMatchInput.addEventListener("change", saveCurrentSettings);

getSettings().then(render).catch(() => render(DEFAULT_SETTINGS));
