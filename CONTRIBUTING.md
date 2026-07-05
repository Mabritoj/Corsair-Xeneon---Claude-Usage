# Contributing

This is a personal hobby project shared as-is under the MIT License. There's no formal contribution process, and issues/PRs aren't actively monitored — fork the repo and change whatever you want.

The notes below just explain how the project is put together, in case you're building on it.

**One rule:** don't commit your Claude credentials, OAuth tokens, or any real usage payloads. Use placeholder values in examples.

## Development setup

1. Clone the repository.
2. Install [Node.js 18+](https://nodejs.org).
3. Install the iCUE widget CLI:

   ```powershell
   npm install -g @icue/icuewidget-cli
   ```

4. Start the bridge while testing:

   ```powershell
   cd bridge
   ./start-bridge.ps1
   ```

5. Validate and package after widget changes:

   ```powershell
   node --check widget/scripts/widget.js
   icuewidget validate widget
   icuewidget package widget
   ```

6. Re-import the generated `claude-usage.icuewidget` in iCUE. After code changes, quit iCUE fully (tray), remove the old widget definition, then import the new package.

## Project layout

| Path | Purpose |
|------|---------|
| `widget/` | iCUE widget (HTML, JS, CSS, manifest, translations) |
| `bridge/` | Local Node bridge that reads Claude credentials and calls the usage endpoint |
| `bridge/run-hidden.vbs` | Generated locally by `install-autostart.ps1` (not committed) |
| `claude-usage.icuewidget` | Packaged widget output (rebuild with `icuewidget package widget`) |

## How it's built

### Widget (`widget/`)

- Keep the widget compatible with the iCUE QtWebEngine sandbox — no external CDN scripts, no direct calls to Anthropic's API (use the bridge).
- Read iCUE properties with the existing `prop()` pattern in `widget/scripts/widget.js`. Don't name a function or variable the same as an iCUE property (e.g. `maxModels`, `pollSeconds`) — iCUE injects those as globals and a same-named declaration throws a redeclaration error.
- New user-facing labels in `index.html` should use the `tr('...')` pattern and get a matching entry in `widget/translation.json`.
- Bump `version` in `widget/manifest.json` when shipping changes, then re-run `icuewidget package widget`.

### Bridge (`bridge/`)

- The bridge must stay bound to `127.0.0.1` only.
- Prefer Node built-in modules; avoid adding dependencies unless necessary.
- Preserve the existing endpoints: `GET /usage` and `GET /health`.
- Never log or return the raw access/refresh token — only normalized utilization percentages and reset timestamps.
- The bridge only writes back to `~/.claude/.credentials.json` when the usage call 401s and it refreshes the token; writes must stay atomic (temp file + rename), as in `server.mjs`.
- Do not commit `run-hidden.vbs`; it contains machine-specific paths and is recreated by `install-autostart.ps1`.
- Restart the bridge after bridge changes for them to take effect.
