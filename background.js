// GitHub PR Live Folder — service worker.
// Keeps a collapsible tab group in sync with your open GitHub PRs:
// - session-cookie fetches against github.com/pulls (JSON payload first,
//   HTML fallback parsed in an offscreen document)
// - session-based searches for approval, requested changes, and draft state
// - direct review requests only (user-review-requested:@me — never team)
// - PRs not updated within maxAgeDays are ignored
// - optional pin-to-top, tab discarding, and newest-first ordering

importScripts("shared.js");

const DEFAULT_STATE = {
  lastSync: null,
  lastError: null,
  signedIn: null, // true / false / unknown
  prCount: 0,
};

const ALARM_NAME = "prs-sync";
const PULLS_URL = "https://github.com/pulls";
// Direct review requests only — never team requests.
const PR_SEARCH_FILTERS = ["user-review-requested:@me", "author:@me"];

// Guard so our own tab moves don't retrigger the onMoved listener.
let repositioning = 0;
let syncPromise = null;
let syncAgain = false;
let repositoryWrite = Promise.resolve();

// ---------------------------------------------------------------- storage

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...(state || {}) };
}

async function saveState(patch) {
  const state = await getState();
  await chrome.storage.local.set({ state: { ...state, ...patch } });
}

function rememberRepositories(repos = []) {
  // Keep one writer so a sync and a manual addition can't overwrite each other.
  const write = repositoryWrite.then(async () => {
    const cfg = await getConfig();
    const { knownRepos } = await chrome.storage.local.get("knownRepos");
    let previous = Array.isArray(knownRepos) ? knownRepos : [];
    if (!Array.isArray(knownRepos)) {
      // Seed the first checklist from tabs created by earlier extension versions.
      const group = await findManagedGroup(cfg);
      if (group) {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        previous = tabs.map((tab) => {
          const url = normalizePrUrl(tab.pendingUrl || tab.url);
          return url ? new URL(url).pathname.split("/").slice(1, 3).join("/") : null;
        });
      }
    }
    const combined = repositoryNames([...previous, ...cfg.excludes, ...repos]);
    if (JSON.stringify(knownRepos) !== JSON.stringify(combined)) {
      await chrome.storage.local.set({ knownRepos: combined });
    }
    return combined;
  });
  repositoryWrite = write.catch(() => {});
  return write;
}

// ---------------------------------------------------------------- github

async function ghFetch(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json,text/html" },
    credentials: "include", // attach the browser's github.com session
  });
  return { status: res.status, text: await res.text(), url: res.url };
}

function buildQuery(cfg, filter) {
  const terms = [
    "is:pr", "is:open", "archived:false", "sort:updated-desc",
    filter || `(${PR_SEARCH_FILTERS.join(" OR ")})`,
  ];
  for (const repo of cfg.excludes) terms.push(`-repo:${repo}`);
  if (cfg.maxAgeDays > 0) {
    const cutoff = new Date(Date.now() - cfg.maxAgeDays * 86400000).toISOString().slice(0, 10);
    terms.push(`updated:>=${cutoff}`);
  }
  return terms.join(" ");
}

// ------------------------------------------------------ review enrichment

async function enrichWithReviewStatus(prs, cfg) {
  const { prMeta: previous = {} } = await chrome.storage.local.get("prMeta");
  const searches = [
    { filter: "review:approved", approval: "approved" },
    { filter: "-review:approved", approval: "not-approved" },
    { filter: "review:changes_requested", approval: "changes-requested" },
  ];
  // Use the same session-based dashboard as PR discovery, without GraphQL or tokens.
  const results = prs.length ? await Promise.allSettled(
    searches.map(({ filter }) => fetchPullRequests(cfg, filter)),
  ) : [];
  const approvals = new Map();
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      errors.push(String(result.reason?.message || result.reason));
      return;
    }
    for (const pr of result.value.items) {
      // Changes requested takes precedence if different reviewers disagree.
      approvals.set(pr.url, searches[index].approval);
    }
  });

  const fetchedAt = Date.now();
  const meta = {};
  let missing = false;
  for (const pr of prs) {
    const approval = approvals.get(pr.url);
    const presentation = { title: pr.title, isDraft: pr.isDraft };
    if (!approval) {
      missing = true;
      meta[pr.url] = { ...previous[pr.url], ...presentation };
      continue;
    }
    meta[pr.url] = {
      ...presentation,
      approval,
      emoji: pr.isDraft ? "🚧" : approval === "approved" ? "✅" : approval === "changes-requested" ? "⚠️" : "👀",
      fetchedAt,
    };
  }
  await chrome.storage.local.set({
    prMeta: meta,
    prMetaState: { error: errors.join("; ") || (missing ? "Some PR approval statuses could not be refreshed." : null) },
  });
}

// ---------------------------------------------------------- offscreen HTML

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Parse GitHub /pulls HTML fallback for PR lists.",
  });
}

async function parseHtmlOffscreen(html) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: "parse-html", html, baseUrl: PULLS_URL });
}

// ---------------------------------------------------------------- badge

async function setBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
}

// ---------------------------------------------------------------- sync

class SignInRequiredError extends Error {
  constructor() {
    super("Not signed in to github.com.");
  }
}

async function fetchPullRequestPage(query, detectFormatOnly = false) {
  const { status, text, url } = await ghFetch(`${PULLS_URL}?q=${encodeURIComponent(query)}`);
  if (status === 401 || status === 404 || (url && new URL(url).pathname === "/login")) {
    throw new SignInRequiredError();
  }
  if (status !== 200) throw new Error(`GitHub returned HTTP ${status}.`);

  // Check each response's format; a prior HTML response must not disable JSON.
  let parsed;
  let isJsonApi = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJsonApi = false;
  }

  let items;
  if (isJsonApi) {
    const route = parsed?.payload?.pullsDashboardSurfaceContentRoute;
    if (route?.error) throw new Error("GitHub could not process the PR search.");
    const nodes = route?.results;
    if (!Array.isArray(nodes)) throw new Error("Unrecognized GitHub PR JSON response.");
    items = nodes.map((pr) => ({
      url: pr?.permalink,
      title: pr?.title || "",
      updatedAt: pr?.updatedAt || "",
      isDraft: Boolean(pr?.isDraft),
    }));
  } else {
    // Probe the format before sending OR queries to the legacy HTML parser.
    if (detectFormatOnly) return { isJsonApi: false };
    const result = await parseHtmlOffscreen(text);
    if (result?.loggedOut) throw new SignInRequiredError();
    if (result?.error) throw new Error(`Could not parse GitHub PRs: ${result.error}`);
    if (!Array.isArray(result?.items)) throw new Error("No PR list returned by the HTML parser.");
    items = result.items;
  }

  return { items, isJsonApi };
}

async function fetchPullRequests(cfg, extraFilter = "") {
  const query = (filter) => [buildQuery(cfg, filter), extraFilter].filter(Boolean).join(" ");
  let { items, isJsonApi } = await fetchPullRequestPage(query(), true);
  if (!isJsonApi) {
    // The legacy /pulls UI doesn't support OR; merge its individual searches.
    items = [];
    for (const filter of PR_SEARCH_FILTERS) {
      const page = await fetchPullRequestPage(query(filter));
      items.push(...page.items);
    }
  }

  const unique = new Map();
  for (const item of items) {
    const key = normalizePrUrl(item?.url);
    if (!key) throw new Error("GitHub returned an invalid PR URL.");
    unique.set(key, {
      url: key,
      title: typeof item.title === "string" ? item.title : "",
      repo: new URL(key).pathname.split("/").slice(1, 3).join("/"),
      updatedAt: item.updatedAt || "",
      isDraft: Boolean(item.isDraft),
    });
  }
  return { items: [...unique.values()] };
}

function sync() {
  if (!syncPromise) {
    syncPromise = (async () => {
      let result;
      do {
        syncAgain = false;
        result = await syncOnce();
      } while (syncAgain);
      return result;
    })().finally(() => { syncPromise = null; });
  }
  return syncPromise;
}

async function syncOnce() {
  try {
    const cfg = await getConfig();
    const { items } = await fetchPullRequests(cfg);
    await rememberRepositories(items.map((pr) => pr.repo));
    const staleCutoff = cfg.maxAgeDays > 0 ? Date.now() - cfg.maxAgeDays * 86400000 : 0;

    // Age cutoff + repository excludes.
    const filtered = items.filter((pr) => {
      if (cfg.excludes.includes((pr.repo || "").toLowerCase())) return false;
      if (staleCutoff && pr.updatedAt && new Date(pr.updatedAt).getTime() < staleCutoff) return false;
      return true;
    });

    await reconcileTabs(filtered, cfg);
    await saveState({ signedIn: true, lastError: null, lastSync: Date.now(), prCount: filtered.length });
    await setBadge(filtered.length ? String(filtered.length) : "");
    try {
      await enrichWithReviewStatus(filtered, cfg);
    } catch (err) {
      await chrome.storage.local.set({ prMetaState: { error: String(err?.message || err) } });
    }
    return { ok: true, count: filtered.length };
  } catch (err) {
    const signedOut = err instanceof SignInRequiredError;
    await saveState({
      lastError: String(err?.message || err),
      lastSync: Date.now(),
      ...(signedOut ? { signedIn: false } : {}),
    });
    if (signedOut) {
      await setBadge("?");
      return { ok: false, signedIn: false };
    }
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "remember-repositories") {
    if (msg.repos !== undefined && (!Array.isArray(msg.repos) || msg.repos.some((repo) => !normalizeRepoName(repo)))) {
      sendResponse({ ok: false, error: "Enter a repository as owner/repo." });
      return false;
    }
    rememberRepositories(msg.repos).then(
      (repos) => sendResponse({ ok: true, repos }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true;
  }
  if (msg?.type === "sync") {
    sync().then(sendResponse);
    return true; // async
  }
  return false;
});

// ---------------------------------------------------------------- tabs

async function moveGroupToFront(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  if (!tabs.length) return;
  const windowId = tabs[0].windowId;
  const pinnedCount = (await chrome.tabs.query({ windowId, pinned: true })).length;
  const minIndex = Math.min(...tabs.map((t) => t.index));
  if (minIndex === pinnedCount) return; // already at front

  repositioning++;
  try {
    await chrome.tabGroups.move(groupId, { index: pinnedCount });
  } catch {
    /* group may have dissolved */
  } finally {
    repositioning--;
  }
}

async function reconcileTabs(prs, cfg) {
  repositioning++;
  try {
    await updateManagedTabs(prs, cfg);
  } finally {
    repositioning--;
  }
}

async function updateManagedTabs(prs, cfg) {
  const ordered = prs.slice();
  if (cfg.sortByUpdated) {
    ordered.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  }
  const keep = ordered.slice(0, Math.max(1, cfg.maxTabs));
  const keepUrls = new Set(keep.map((pr) => normalizePrUrl(pr.url)));

  let group = await findManagedGroup(cfg);
  let groupId = group?.id ?? null;
  let groupTabs = [];
  if (groupId != null) {
    groupTabs = await chrome.tabs.query({ groupId });
  }
  const existingUrls = new Set(groupTabs.map((tab) => normalizePrUrl(tab.pendingUrl || tab.url)));

  // 1. Add tabs for new PRs.
  for (const pr of keep) {
    if (existingUrls.has(normalizePrUrl(pr.url))) continue;
    const tab = await chrome.tabs.create({
      url: pr.url,
      active: false,
      ...(group ? { windowId: group.windowId } : {}),
    });
    if (groupId == null) {
      groupId = await chrome.tabs.group({ tabIds: tab.id });
      group = { id: groupId, windowId: tab.windowId };
      await chrome.storage.session.set({ managedGroupId: groupId });
      await chrome.tabGroups.update(groupId, {
        title: cfg.groupTitle,
        color: cfg.groupColor,
        collapsed: cfg.collapsed,
      });
    } else {
      await chrome.tabs.group({ tabIds: tab.id, groupId });
    }
    existingUrls.add(normalizePrUrl(pr.url));
  }

  // 2. Remove tabs whose PR is closed/merged, filtered out, or beyond maxTabs.
  const seen = new Set();
  // Retain the active tab when a previous version created duplicates.
  for (const t of groupTabs.slice().sort((a, b) => Number(b.active) - Number(a.active))) {
    const key = normalizePrUrl(t.pendingUrl || t.url);
    if (!key) continue; // leave unrelated tabs the user put in the group alone
    if (!keepUrls.has(key) || seen.has(key)) {
      try {
        await chrome.tabs.remove(t.id);
      } catch {
        /* already gone */
      }
    }
    seen.add(key);
  }

  // 3. Keep title/color in sync with settings.
  if (groupId != null) {
    try {
      await chrome.tabGroups.update(groupId, { title: cfg.groupTitle, color: cfg.groupColor });
      await chrome.storage.local.set({ managedGroupTitle: cfg.groupTitle });
    } catch {
      /* group dissolved */
    }
  }

  // 4. Newest-first ordering (query again for fresh indexes).
  if (cfg.sortByUpdated && groupId != null) {
    groupTabs = await chrome.tabs.query({ groupId });
    const windowIds = new Set(groupTabs.map((t) => t.windowId));
    if (windowIds.size === 1) {
      const windowId = [...windowIds][0];
      const firstIndex = Math.min(...groupTabs.map((t) => t.index));
      let i = 0;
      for (const pr of keep) {
        const tab = groupTabs.find((t) => normalizePrUrl(t.pendingUrl || t.url) === normalizePrUrl(pr.url));
        if (tab) {
          try {
            await chrome.tabs.move(tab.id, { windowId, index: firstIndex + i });
            i++;
          } catch {
            /* move failed */
          }
        }
      }
    }
  }

  // 5. Discard loaded, inactive tabs to keep memory light.
  if (cfg.discardTabs && groupId != null) {
    const tabs = await chrome.tabs.query({ groupId });
    for (const t of tabs) {
      if (normalizePrUrl(t.url) && !t.discarded && !t.active && !t.pinned && t.status === "complete") {
        try {
          await chrome.tabs.discard(t.id);
        } catch {
          /* not discardable */
        }
      }
    }
  }

  // 6. Snap the folder back to the top if it drifted.
  if (cfg.pinToTop && groupId != null) {
    await moveGroupToFront(groupId);
  }
}

async function scheduleAlarm() {
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.5,
    periodInMinutes: SYNC_DEFAULTS.pollMinutes,
  });
}

// ---------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  await sync();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await sync();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config && syncPromise) syncAgain = true;
});

// Discard PR tabs the moment they finish loading (unless active).
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  const cfg = await getConfig();
  if (!cfg.discardTabs) return;
  if (changeInfo.status !== "complete" || changeInfo.discarded) return;
  if (!normalizePrUrl(tab.url)) return;
  if (tab.active || tab.pinned) return;
  try {
    const group = await findManagedGroup(cfg);
    if (!group || tab.groupId !== group.id) return;
    await chrome.tabs.discard(tab.id);
  } catch {
    /* not in our group */
  }
});

// Snap the folder back to the top when the user drags things around.
chrome.tabs.onMoved.addListener(async (_tabId, info) => {
  if (repositioning) return;
  const cfg = await getConfig();
  if (!cfg.pinToTop || repositioning) return;
  const group = await findManagedGroup(cfg);
  if (!group || group.windowId !== info.windowId || repositioning) return;
  const groupId = group.id;
  const tabs = await chrome.tabs.query({ groupId });
  if (!tabs.length) return;
  const pinnedCount = (await chrome.tabs.query({ windowId: info.windowId, pinned: true })).length;
  const minIndex = Math.min(...tabs.map((t) => t.index));
  if (minIndex > pinnedCount) await moveGroupToFront(groupId);
});
