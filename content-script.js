// GitHub PR Live Folder — content script.
// Decorates GitHub PR tab titles with the live status emoji maintained by the
// service worker (🚧 draft, ✅ approved, ⚠️ changes requested, 👀 not approved).
// Re-applies itself whenever GitHub
// rewrites the title (SPA navigation) or the sync updates the metadata.

const META_KEY = "prMeta";

async function apply() {
  const key = normalizePrUrl(location.href);
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  if (key !== normalizePrUrl(location.href)) return; // navigated during the read
  const info = key ? meta?.[key] : null;
  const prefix = info?.emoji ? `${info.emoji} ` : "";
  const base = document.title.replace(PR_STATUS_PREFIX_RE, "");
  if (prefix + base === document.title) return;
  document.title = prefix + base;
}

// GitHub is an SPA: it rewrites <title> during navigation. Re-apply our
// prefix whenever it changes.
const titleEl = document.querySelector("title");
if (titleEl) {
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      apply();
    }, 50);
  }).observe(titleEl, { childList: true, characterData: true, subtree: true });
}

// Re-apply when the service worker refreshes metadata (e.g. CI goes green).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[META_KEY]) apply();
});

apply();
