const $ = (id) => document.getElementById(id);

const FIELDS = ["groupTitle", "groupColor", "collapsed", "pinToTop"];
let excludedRepos = new Set();
let excludedOrgs = new Set();
let knownRepos = [];

function renderOrganizations() {
  const list = $("orgList");
  const orgs = ownerNames([...knownRepos.map(repoOwner), ...excludedOrgs]);
  list.replaceChildren();
  if (!orgs.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No organizations yet. Sync to discover them, or add one below.";
    list.appendChild(empty);
    return;
  }
  for (const org of orgs) {
    const label = document.createElement("label");
    label.className = "checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = excludedOrgs.has(org);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) excludedOrgs.add(org);
      else excludedOrgs.delete(org);
      renderRepositories();
    });
    label.append(checkbox, document.createTextNode(org));
    list.appendChild(label);
  }
}

function renderRepositories() {
  const list = $("repoList");
  list.replaceChildren();
  if (!knownRepos.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No repositories yet. Sync to discover them, or add one below.";
    list.appendChild(empty);
    return;
  }
  for (const repo of knownRepos) {
    const covered = excludedOrgs.has(repoOwner(repo));
    const label = document.createElement("label");
    label.className = "checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = covered || excludedRepos.has(repo);
    checkbox.disabled = covered; // the excluded organization already covers it
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) excludedRepos.add(repo);
      else excludedRepos.delete(repo);
    });
    label.append(checkbox, document.createTextNode(covered ? `${repo} — organization excluded` : repo));
    list.appendChild(label);
  }
}

function refreshRepositories(repos = []) {
  knownRepos = repositoryNames([...knownRepos, ...repos, ...excludedRepos]);
  renderOrganizations();
  renderRepositories();
}

async function loadConfig() {
  const cfg = await getConfig();
  excludedRepos = new Set(cfg.excludes);
  excludedOrgs = new Set(cfg.excludedOrgs);
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (el.type === "checkbox") {
      el.checked = cfg[f];
    } else {
      el.value = cfg[f];
    }
  }
  refreshRepositories(cfg.excludes);
  try {
    const result = await chrome.runtime.sendMessage({ type: "remember-repositories", repos: cfg.excludes });
    if (!result?.ok) throw new Error(result?.error || "Could not load saved repositories.");
    refreshRepositories(result.repos);
  } catch (err) {
    $("repoError").textContent = String(err?.message || err);
  }
}

async function saveConfig() {
  const cfg = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (el.type === "checkbox") cfg[f] = el.checked;
    else cfg[f] = el.value.trim();
  }
  // Repos already covered by an excluded organization don't need their own entry.
  cfg.repoExcludes = repositoryNames([...excludedRepos])
    .filter((repo) => !excludedOrgs.has(repoOwner(repo)))
    .join("\n");
  cfg.orgExcludes = ownerNames([...excludedOrgs]).join("\n");
  if (!cfg.groupTitle) cfg.groupTitle = DEFAULT_CONFIG.groupTitle;
  await chrome.storage.local.set({ config: cfg });
  excludedRepos = new Set(cfg.repoExcludes.split("\n").filter(Boolean));
  excludedOrgs = new Set(cfg.orgExcludes.split("\n").filter(Boolean));
  refreshRepositories();
  return cfg;
}

$("addRepoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("repoError").textContent = "";
  const repo = normalizeRepoName($("newRepo").value);
  if (!repo) {
    $("repoError").textContent = "Enter a repository as owner/repo.";
    $("newRepo").focus();
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: "remember-repositories", repos: [repo] });
    if (!result?.ok) throw new Error(result?.error || "Could not save this repository.");
    excludedRepos.add(repo);
    refreshRepositories(result.repos);
    $("newRepo").value = "";
  } catch (err) {
    $("repoError").textContent = String(err?.message || err);
  }
});

$("addOrgForm").addEventListener("submit", (event) => {
  event.preventDefault();
  $("orgError").textContent = "";
  const org = normalizeOwnerName($("newOrg").value);
  if (!org) {
    $("orgError").textContent = "Enter an organization name.";
    $("newOrg").focus();
    return;
  }
  excludedOrgs.add(org);
  refreshRepositories();
  $("newOrg").value = "";
});

function renderStatus() {
  chrome.storage.local.get("state", ({ state }) => {
    const s = state || {};
    const status = $("status");
    if (s.signedIn === false) {
      status.className = "error";
      status.textContent = "Not signed in to GitHub. Open github.com and sign in, then hit Sync.";
      return;
    }
    if (s.lastError) {
      status.className = "error";
      status.textContent = `Last sync failed: ${s.lastError}`;
      return;
    }
    if (s.lastSync) {
      const when = new Date(s.lastSync).toLocaleTimeString();
      status.className = "";
      status.textContent = `Last sync ${when} — ${s.prCount} open PR${s.prCount === 1 ? "" : "s"} in the folder.`;
    } else {
      status.className = "";
      status.textContent = "Waiting for first sync…";
    }
  });
}

$("save").addEventListener("click", async () => {
  await saveConfig();
  chrome.runtime.sendMessage({ type: "sync" });
  $("save").textContent = "Saved ✓";
  setTimeout(() => ($("save").textContent = "Save"), 1500);
});

$("test").addEventListener("click", async () => {
  await saveConfig();
  $("status").textContent = "Syncing…";
  chrome.runtime.sendMessage({ type: "sync" }, renderStatus);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.state) renderStatus();
  if (area === "local" && changes.knownRepos) refreshRepositories(changes.knownRepos.newValue || []);
});

loadConfig().then(renderStatus);
