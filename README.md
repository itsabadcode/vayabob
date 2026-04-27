# Vayabob Chrome Extension

Hides irrelevant Wallapop search results and marks visited items.

## Behavior

- Runs on all `https://*.wallapop.com/*` locales.
- On `/item/...-{id}` pages, stores the item id in `chrome.storage.local.viewed`.
- `viewed` is an array of `{ id, viewedAt }` entries, older than 30 days are purged automatically.
- On `/search?...keywords=...`, result cards with no title match against any keyword token are dimmed with `opacity: 0.2`.
- Keyword tokens match on word/number boundaries, so `7` matches `Ryzen 7` but not `B760` or `LGA1700`.
- Search result cards whose id exists in `viewed` get an eye overlay on the image area.
- Search result cards containing `wallapop-badge[badge-type="reserved"]` are shown in grayscale.
- The extension icon opens a menu with search matching options.
- `Every word` changes matching from any word to every word, with extra title words allowed.
- `Exact match` requires the item title to have exactly the same words as the query in any order, case-insensitively.

## Installation

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `extension` directory.
5. Pin the extension to your toolbar for easy access.
