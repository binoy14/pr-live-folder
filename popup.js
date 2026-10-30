const $ = (id) => document.getElementById(id);
let prListVersion = 0;

function approvalStatus(info) {
  switch (info.approval) {
    case "approved": return { text: "Approved", className: "approved" };
    case "changes-requested": return { text: "Changes requested", className: "changes-requested" };
    case "not-approved": return { text: "Not approved", className: "not-approved" };
    default: return { text: "Approval unavailable", className: "unknown" };
  }
}

async function renderStatus() {
  const { state } = await chrome.storage.local.get("state");
  const s = state || {};
  const status = $("status");
  status.className = "";
  if (s.signedIn === false) {
    status.className = "error";
    status.innerHTML = 'Not signed in to GitHub. <a href="https://github.com" target="_blank">Open github.com</a>, sign in, then Sync.';
    return;
  }
  if (s.lastError) {
    status.className = "error";
    status.textContent = `Sync failed: ${s.lastError}`;
    return;
  }
  if (s.lastSync) {
    const when = new Date(s.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    status.textContent = `${s.prCount} open PR${s.prCount === 1 ? "" : "s"} · Synced ${when}`;
  } else {
    status.textContent = "Waiting for first sync…";
  }
}

async function renderPrList() {
  const version = ++prListVersion;
  const cfg = await getConfig();
  const group = await findManagedGroup(cfg);
  const { prMeta, prMetaState } = await chrome.storage.local.get(["prMeta", "prMetaState"]);
  const meta = prMeta || {};
  const tabs = group ? await chrome.tabs.query({ groupId: group.id }) : [];
  if (version !== prListVersion) return;
  const list = document.createDocumentFragment();
  let hasSavedApproval = false;
  for (const t of tabs) {
    const key = normalizePrUrl(t.pendingUrl || t.url);
    if (!key) continue;
    const repoName = new URL(key).pathname.split("/").slice(1, 3).join("/");
    const number = new URL(key).pathname.split("/")[4];
    const info = meta[key] || {};
    const approval = approvalStatus(info);
    if (approval.className !== "unknown") hasSavedApproval = true;
    const li = document.createElement("li");
    const a = document.createElement("a");
    const tabTitle = (t.title || "")
      .replace(PR_STATUS_PREFIX_RE, "")
      .replace(/ by [^\s]+ · Pull Request #\d+ · .+$/u, "");
    const title = info.title?.trim() || (tabTitle !== key ? tabTitle : "") || `Pull request #${number}`;
    a.className = "pr-title";
    a.href = t.pendingUrl || t.url;
    a.textContent = title;
    a.title = title;
    const details = document.createElement("div");
    details.className = "pr-meta";
    const repo = document.createElement("span");
    repo.className = "repo";
    repo.textContent = `${repoName} #${number}`;
    const badges = document.createElement("span");
    badges.className = "pr-badges";
    if (info.isDraft) {
      const draft = document.createElement("span");
      draft.className = "draft";
      draft.textContent = "Draft";
      badges.appendChild(draft);
    }
    const badge = document.createElement("span");
    badge.className = `approval ${approval.className}`;
    badge.textContent = approval.text;
    if (info.fetchedAt) badge.title = `Last checked ${new Date(info.fetchedAt).toLocaleString()}`;
    badges.appendChild(badge);
    details.append(repo, badges);
    li.appendChild(a);
    li.appendChild(details);
    list.appendChild(li);
  }
  $("prList").replaceChildren(list);
  $("approvalNotice").textContent = prMetaState?.error && tabs.length
    ? (hasSavedApproval ? "Showing saved approval status; refresh failed." : "Approval status is currently unavailable.")
    : "";
}

$("sync").addEventListener("click", async () => {
  $("status").textContent = "Syncing…";
  chrome.runtime.sendMessage({ type: "sync" }, () => {
    renderStatus();
    renderPrList();
  });
});

$("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.state) renderStatus();
  if (changes.state || changes.prMeta || changes.prMetaState || changes.config) renderPrList();
});

renderStatus();
renderPrList();
