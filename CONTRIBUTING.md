# Contributing

Use Node.js 24.15.0 or newer (`.nvmrc` selects Node 24) and npm:

```sh
npm ci
npm run lint
npm test
env -u OBSIDIAN_PLUGIN_DIR -u OBSIDIAN_VAULT_DIR npm run build
git diff --check
```

The build runs both the normal and browser-only TypeScript checks. The latter
excludes ambient Node declarations so browser APIs must be declared explicitly.
Obsidian, CodeMirror, Lezer, Electron and Node built-ins remain external modules.

## Test in Obsidian

Use a disposable vault and synthetic Markdown rather than personal notes. Copy
`main.js`, `manifest.json` and `styles.css` into its configuration folder under
`plugins/inline-review-comment/`, then enable or reload the plugin. Never replace
`data.json` in an existing installation. Unposted drafts are session-only; keep
them before reloading a plugin.

For renderer changes, test Source, Live Preview and Reading views with Default
and Primary themes. Include table headers and cells, lists, quotes, callouts,
footnotes, narrow panes, popouts, posting/replying/editing and saved Markdown.
Check that cards do not duplicate or overlap text and that table-cell editors
have no margin gutter. Agent integration fixtures do not prove a real provider
authenticated or ran successfully.

## Report a problem or propose a change

Include the plugin and Obsidian versions, operating system, theme, view mode,
reproduction steps, a small synthetic note, and expected versus actual behavior.
Sanitize console output and screenshots before sharing them. Add focused
regression coverage for behavioral fixes and run the checks above.

Use Conventional Commits. Semantic-release owns version bumps, compatibility
metadata and the changelog; leave those generated files to the release process.
The release workflow attests the final published assets and verifies downloaded
bytes and provenance. A no-release run skips attestation. If attestation fails
after publication, the workflow fails but the existing release is not rolled back;
inspect that run before retrying, since a no-release rerun will not backfill it.

Local checks do not reproduce the hosted review environment. Match a new
scorecard's source revision before claiming a finding is resolved. An unavailable
malware scan remains a coverage gap.
