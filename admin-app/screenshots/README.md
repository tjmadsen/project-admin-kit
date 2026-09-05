# Admin console screenshot harness

Renders the real admin pages and stylesheet against fixture data so UI changes
can be reviewed and diffed without a Firebase session.

```bash
cd admin-app
node screenshots/capture.mjs shoot ../docs/fr-N/screenshots/after --themes light,dark
node screenshots/capture.mjs compare ../docs/fr-N/screenshots/before ../docs/fr-N/screenshots/after ../docs/fr-N/screenshots/diff
```

- `shoot` writes `<scene>-<viewport>-<theme>.png` for the Dashboard, the feature
  list, the FR-25 detail, Agent Loops, and (mobile only) the open navigation
  drawer, at 1440×900 and 390×844.
- `compare` reports changed pixels and the largest per-channel delta for every
  matching file, separately for the main column (right of the 250px sidebar),
  and writes red-on-ghost diff images plus `summary.json`.
- Themes: `light`, `dark`, `system-light`, `system-dark`. The `system-*` values
  store `system` and emulate the OS preference, exercising the
  `prefers-color-scheme` path in `index.css`.

Requirements: a Playwright module (`PLAYWRIGHT_MODULE=/path/to/node_modules/playwright`,
otherwise any copy cached by `npx` is used) and Google Chrome, or
`CHROMIUM_PATH` pointing at a Chromium binary. `vite.config.ts` here aliases
`lib/firebase` and the data hooks to `mocks/`, so nothing touches production.
