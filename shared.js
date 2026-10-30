// Loaded by the worker, extension pages, and content script.
const GITHUB_DEFAULTS = {
  authorMe: true,
  assignedMe: false,
};

const SYNC_DEFAULTS = {
  maxAgeDays: 30,
  pollMinutes: 2,
  maxTabs: 30,
  discardTabs: true,
  sortByUpdated: true,
};

const DEFAULT_CONFIG = {
  ...GITHUB_DEFAULTS,
  repoExcludes: "",
  groupTitle: "GitHub PRs",
  groupColor: "blue",
  collapsed: true, // applied only when the group is created
  pinToTop: true,
  ...SYNC_DEFAULTS,
};

const PR_STATUS_PREFIX_RE = /^(?:(?:🚧|✅|⚠️?|👀|❌|⏳|🧪)\s)+/u;

function normalizeRepoName(value) {
  if (typeof value !== "string") return null;
  const repo = value.trim().toLowerCase();
  return /^[a-z\d_-]+\/[a-z\d._-]+$/.test(repo) ? repo : null;
}

function repositoryNames(values) {
  return [...new Set(values.map(normalizeRepoName).filter(Boolean))].sort();
}

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}), ...GITHUB_DEFAULTS, ...SYNC_DEFAULTS };
  cfg.excludes = repositoryNames((cfg.repoExcludes || "").split("\n"));
  return cfg;
}

function normalizePrUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:\/|$)/);
    if (parsed.origin !== "https://github.com" || !match) return null;
    return `https://github.com/${match[1].toLowerCase()}/pull/${match[2]}`;
  } catch {
    return null;
  }
}

async function findManagedGroup(cfg) {
  // Chrome group IDs are valid only for this browser session.
  const { managedGroupId } = await chrome.storage.session.get("managedGroupId");
  if (Number.isInteger(managedGroupId)) {
    try {
      return await chrome.tabGroups.get(managedGroupId);
    } catch {
      await chrome.storage.session.remove("managedGroupId");
    }
  }

  // Recover after a browser restart, or adopt a group from an older version.
  const { managedGroupTitle } = await chrome.storage.local.get("managedGroupTitle");
  const groups = await chrome.tabGroups.query({});
  for (const title of [managedGroupTitle, cfg.groupTitle]) {
    if (!title) continue;
    const group = groups.find((candidate) => candidate.title === title);
    if (group) {
      await chrome.storage.session.set({ managedGroupId: group.id });
      return group;
    }
  }
  return null;
}
