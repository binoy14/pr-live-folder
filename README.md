# GitHub PR Live Folder (Chrome extension)

An experimental, open-source Manifest V3 extension that keeps a collapsible tab group in sync
with your open GitHub pull requests, inspired by Arc's Live Folders. Released under the
[MIT license](LICENSE).

It reuses your existing github.com browser session, so you don't need a personal access token
or OAuth setup.

> **Experimental: expect bugs and potentially high memory use.** This is an approximation of
> Arc's Live Folders using Chrome tab groups. The full Arc experience is not available through
> this extension. Each PR opens as a real tab, which can consume substantial memory when many
> PRs load. The extension tries to discard inactive tabs after they finish loading, but that
> does not prevent the initial loading cost or guarantee low memory use. Collapsing the group
> only hides its tabs. Use it as an experiment, and disable it if it makes Chrome sluggish.

## How it works

The extension fetches `https://github.com/pulls?q=…` with your session cookies and reads GitHub's
own React frontend data (a JSON payload), the same technique Zen Browser uses in its
`GithubLiveFolder.sys.mjs`:

1. Fetch `/pulls?q=…` with `Accept: application/json,text/html` and `credentials: 'include'`.
2. GitHub returns a JSON payload (`payload.pullsDashboardSurfaceContentRoute.results`) — each
   entry has `repoNameWithOwner`, `title`, `number`, `author.displayLogin`, `permalink`.
3. If GitHub serves the old HTML UI instead, the extension parses it in an offscreen document
   (MV3 service workers can't use DOMParser).
4. A tab is created for each new open PR and removed when its PR closes, merges, or is filtered out.
   Failed requests and unrecognized responses leave existing tabs in place.

PRs you created and direct review requests are included automatically, using these filters:

- `author:@me` — PRs I created
- `user-review-requested:@me` — PRs where I was directly asked to review (excludes team requests)
- `-repo:owner/repo` — excluded repositories

Combined with `is:pr is:open archived:false sort:updated-desc`.
Sync runs automatically every 2 minutes, keeps up to 30 tabs, and uses a 30-day age limit.
Tabs are ordered by most recently updated and inactive PR tabs are discarded to save memory.
These sync defaults are built in.

Settings keeps a permanent checklist of repositories discovered during sync. Check a repository
to exclude it, uncheck it to include it again, then click Save. Repositories remain listed when
their PRs close or fall outside the age limit. You can also add repositories manually; existing
text-based exclusions appear as checked entries automatically. The list is saved locally and
survives browser restarts and extension updates.

## Setup

Requires Chrome 116 or later. No build step or dependency installation is needed.

1. Clone this repository, or download and extract its ZIP from GitHub:

   ```sh
   git clone https://github.com/binoy14/pull-request-live-extension.git
   cd pull-request-live-extension
   ```

2. Make sure you're signed in to [github.com](https://github.com) in the Chrome profile where
   you'll load the extension.
3. Load the extension:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked** and select the directory containing `manifest.json`.
4. Click the extension icon → **Settings** → choose repository exclusions and folder style → **Save**.
5. Click **Sync now**. If matching PRs are found, a collapsed "Pull Requests" tab group appears
   in your active window. Expand it to open a PR, or use the extension popup to see its status.

The extension manages tabs inside this group. It can close PR tabs when they close, merge,
fall outside the 30-day update window, or exceed the 30-tab limit. Avoid using managed PR tabs
for unfinished work you need to keep open.

### Update or disable

To update a cloned copy, run `git pull` in the repository, then open `chrome://extensions` and
click the extension's reload button. If you downloaded a ZIP, replace the extracted files with
the updated copy before reloading.

To stop automatic syncing and tab management, switch the extension off in `chrome://extensions`.
Choose **Remove** there to uninstall it. Closing the tab group alone does not stop syncing;
the extension can recreate it on the next sync.

## Pin to top

By default, the folder is pinned to the top of the tab strip. The extension listens to
`chrome.tabs.onMoved` and snaps the group back to the first position whenever the user drags
other tabs above it or drags the group itself away. Pinned tabs are respected — the group sits
right below them. You can turn this behavior off in Settings.

## Architecture (POC)

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; permissions: `tabs`, `tabGroups`, `alarms`, `storage`, `offscreen` |
| `background.js` | Service worker: session fetch, JSON/HTML parsing, tab-group reconciliation, badge count |
| `shared.js` | Shared defaults, PR URL normalization, and managed-group lookup |
| `offscreen.html` / `offscreen.js` | DOMParser-based HTML fallback (MV3 has no DOM in the service worker) |
| `options.html` / `options.js` | Settings: persistent repository exclusions and group style |
| `popup.html` / `popup.js` | Quick status, PR list, manual "Sync now" |
| `icons/` | Extension icons (generated by `scripts/make-icons.py`) |

### Why session cookies instead of the GitHub API

| | API + PAT | Session + frontend endpoint (Arc/Zen) |
|---|---|---|
| Setup | Create token, paste it | None — just be logged in |
| Multi-org access | Fine-grained tokens are single-owner; classic tokens fragile | Works automatically (SSO cookie is the browser's) |
| Rate limits | 30 req/min search API | None documented for frontend endpoints |

Confirmed behavior in Chromium: a service worker `fetch()` with `credentials: 'include'` and
`host_permissions: ["https://github.com/*"]` attaches the user's github.com cookies, including
httpOnly ones.

## Notes and limitations

- **Experimental status**: behavior may change or break. This project does not promise the
  same interaction or memory efficiency as Arc's native Live Folders. The built-in tab limit
  and discarding reduce resource use, but many PR tabs loading together can still be expensive.
- **Unofficial interface**: `payload.pullsDashboardSurfaceContentRoute` is not a documented API —
  GitHub could change its shape (Zen has had to fix this in the past). The HTML fallback is a
  partial safety net.
- **Sign-in state**: if you're not signed in to github.com, requests fail with 404 or a
  logged-out page; the extension shows a sign-in hint rather than an error.
- **First sync**: after loading the extension, click "Sync now" once — the initial install
  sync runs automatically but may race with your first Chrome window.
- **Tab group dissolution**: if you close all tabs in the group, Chrome removes the group.
  The extension recreates it on the next sync.
- **Collapsed state**: only applied when the group is *first* created, so expanding it manually
  isn't fought by the extension.
- **Group identity**: renaming the folder in Settings updates the existing group. Comment links,
  query strings, and PR subpages such as Files changed keep the same managed tab.
- **Status metadata**: approval and requested-change status use GitHub's `review:approved`,
  `-review:approved`, and `review:changes_requested` search filters with your browser session.
  The toolbar popup shows an explicit approval badge for each PR and updates while open.
  If enrichment fails, PR syncing continues; the popup identifies
  unavailable approval data or saved results that could not be refreshed.
- **GitHub Enterprise**: self-hosted GHE instances are not supported (matches Arc's limitation).

## Contributing

Bug reports and pull requests are welcome. For bug reports, include your Chrome version,
steps to reproduce, and any relevant errors from the extension's service worker console
(`chrome://extensions` → this extension → **service worker**). Remove private repository names,
PR titles, session information, and other sensitive data before sharing logs or screenshots.

## License

[MIT](LICENSE). Copyright (c) 2026 Binoy Patel. Provided as-is, without warranty.
