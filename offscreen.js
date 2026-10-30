// Offscreen document: the only place in MV3 with DOMParser available.
// Parses the old GitHub HTML UI as a fallback when /pulls doesn't return JSON.

function parseHtml(html, baseUrl = "https://github.com/pulls") {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Logged-out detection: GitHub renders the login page for anonymous users.
  if (doc.body?.classList.contains("logged-out") || doc.querySelector('a[href^="/login"]')) {
    return { items: [], loggedOut: true };
  }

  const links = doc.querySelectorAll('a[data-testid="issue-listitem-title-link"], a[id^="issue_"]');
  if (!links.length && !doc.querySelector(
    '.issues-listing .blankslate, .js-navigation-container .blankslate, [data-testid="issue-list-empty-state"]',
  )) {
    throw new Error("Unrecognized GitHub PR HTML response.");
  }
  const items = [];

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) throw new Error("Missing PR link URL.");
    const url = new URL(href, baseUrl);
    const m = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:\/|$)/);
    if (url.origin !== "https://github.com" || !m) throw new Error("Invalid PR link URL.");
    const row = link.closest('li, div[id^="issue_"]');
    const relTime = row?.querySelector("relative-time");
    items.push({
      url: url.href,
      title: link.textContent.trim(),
      updatedAt: relTime?.getAttribute("datetime") || "",
      isDraft: Boolean(row?.querySelector(".octicon-git-pull-request-draft")),
    });
  }

  return { items, loggedOut: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "parse-html") {
    try {
      sendResponse(parseHtml(msg.html, msg.baseUrl));
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
  return false;
});
