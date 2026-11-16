# Agent guide

## Project

GitHub PR Live Folder is an experimental Chrome Manifest V3 extension. It keeps
a tab group in sync with open PRs authored by the user or directly requesting
their review. It uses the existing github.com browser session, without tokens
or OAuth. Read `README.md` for setup and user-visible behavior.

The extension is plain JavaScript, HTML, and CSS. There is no package manager,
build step, automated test suite, or configured linter. Chrome loads the repo
directly as an unpacked extension; `manifest.json` requires Chrome 116 or later.

## File map

- `background.js`: service worker; GitHub fetching, response validation, review
  enrichment, sync scheduling, repository discovery, and tab reconciliation.
- `shared.js`: defaults, config loading, repository/organization and PR URL normalization,
  and managed-group lookup. Loaded with `importScripts` in the worker and before
  page/content scripts. Keep it usable in all those contexts; avoid DOM access.
- `offscreen.html` / `offscreen.js`: DOMParser-based fallback for GitHub HTML.
  Service workers have no DOM; keep HTML parsing in the offscreen document.
- `content-script.js`: updates GitHub PR tab-title status prefixes and handles
  GitHub title changes during SPA navigation.
- `options.html` / `options.js`: repository and organization exclusions, group appearance.
- `popup.html` / `popup.js`: sync status, managed PR list, approval badges, and
  manual sync. `theme.css` supplies shared styles for the extension pages.
- `scripts/make-icons.py`: generates the committed `icons/*.png` using only the
  Python standard library. Run `python3 scripts/make-icons.py` when changing icons.

## Behavior to preserve

- Fetch GitHub with session credentials. Keep host access scoped to github.com;
  self-hosted GitHub Enterprise is outside the current scope.
- Include authored PRs and direct review requests (`user-review-requested:@me`).
  Team review requests are intentionally excluded.
- Hide PRs the signed-in user already approved (`reviewed-by:@me review:approved`).
  A failed lookup must keep existing tabs.
- Exclude repositories and organizations (`-repo:owner/repo`, `-org:owner`). An excluded
  organization covers its repositories, so don't store or query redundant `-repo` terms.
- Treat a recognized empty response separately from a failed or unrecognized
  response. Fetch, authentication, and parsing failures must leave existing tabs
  in place. Review-enrichment failures must not stop PR discovery and syncing.
- Use `normalizePrUrl` for PR identity so query strings, comment fragments, and
  subpages reuse the same tab. Preserve unrelated tabs placed in the group.
- Recover the managed group across worker/browser restarts. Group IDs belong in
  `chrome.storage.session`; the recovery title belongs in `chrome.storage.local`.
  Apply the collapsed setting only when creating the group.
- Keep sync calls serialized and preserve the tab-move recursion guard. Discard
  only eligible inactive managed PR tabs; respect pinned tabs when positioning
  the group.
- Keep repository discovery persistent and writes serialized through
  `rememberRepositories`. Checked repositories are excluded; closing a PR must
  not remove its repository from the checklist.
- `SYNC_DEFAULTS` in `shared.js` overrides stored sync settings: two-minute
  polling, 30-day age limit, 30-tab cap, newest-first order, and tab discarding.
  Coordinate intentional changes with the README and affected UI.

## Making changes

Follow the existing two-space indentation, semicolons, and double-quoted JS
strings. Keep changes focused and use the current browser APIs and script-loading
pattern. Add dependencies or tooling only when the task calls for them.

Use DOM creation and `textContent` for GitHub-provided titles and repository
names. Keep session information and private PR data out of logs, fixtures, and
screenshots. Update `README.md` when setup or user-visible behavior changes.

## Validation

Run these checks from the repo root when changing JavaScript or the manifest
(Node and Python are local validation tools, not extension runtime dependencies):

```sh
for file in *.js; do node --check "$file" || exit 1; done
python3 -m json.tool manifest.json > /dev/null
git diff --check
```

Syntax checks do not exercise Chrome APIs. For runtime changes, load or reload
the unpacked extension at `chrome://extensions`, reopen popup/settings pages,
and refresh GitHub PR pages when changing the content script. Inspect the
extension's service worker console for errors. Use a test Chrome profile for
tab-management checks: sync can close managed PR tabs.

Choose manual checks relevant to the change:

- Sync twice: PR tabs appear once, the badge and popup update, and unchanged
  PRs keep their tabs, including tabs on Files changed or comment URLs.
- Save exclusions and group styling, reload the extension, and confirm settings
  and discovered repositories persist. Renaming should reuse the group.
- For reconciliation changes, check removal of filtered PRs, preservation of
  unrelated tabs, pinned-tab positioning, manual expansion, and inactive-tab
  discarding. Check recovery after a browser restart when changing group lookup.
- For fetch/parser changes, cover valid populated and empty JSON/HTML responses,
  sign-out, HTTP failure, and malformed responses. Failures must preserve tabs;
  unavailable review status should surface in the popup without blocking sync.

Report which checks ran and which browser scenarios remain unverified. For a
documentation-only change, review the text against the code and run
`git diff --check`; browser testing is unnecessary.
