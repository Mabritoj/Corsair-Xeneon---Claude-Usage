# Claude Usage — Corsair Xeneon Edge Widget

Live Claude subscription usage on your Corsair Xeneon Edge display via iCUE.

This project has two parts:

- **`widget/`** — the iCUE widget itself, which renders on your Xeneon Edge tile.
- **`bridge/`** — a small Node server that runs on your PC and talks to Anthropic on the widget's behalf. It exists because an iCUE widget runs in a sandboxed browser and can't read your Claude OAuth token from disk or call `api.anthropic.com` directly (no CORS, and the usage endpoint needs a custom header).

**What it shows:**

- Current 5-hour session usage
- Weekly usage across all models
- Per-model weekly usage, where your account exposes it (Opus / Sonnet / Fable / etc.), most-active first
- Time until each limit resets
- A "Claude sign-in needed" message if your token has expired and can't be refreshed, instead of stale or broken numbers

## Requirements

- **Windows** with [iCUE 5.47+](https://www.corsair.com/icue) and a **Xeneon Edge**
- **Node.js 18+** for the local bridge
- **Claude Code** signed in with a Claude.ai subscription (Pro/Max). The bridge reuses the OAuth token Claude Code already stored — if you're using a raw `ANTHROPIC_API_KEY` instead, the usage endpoint returns 401 and no data is available (an Anthropic limitation, not a bug in this project)

## Installation

### 1. Get the project

Clone or download this repository. A pre-built widget is included — you do not need to build anything to get started.

### 2. Start the bridge

```powershell
cd bridge
./start-bridge.ps1
```

Verify it is running: [http://127.0.0.1:37650/usage](http://127.0.0.1:37650/usage) — you should see JSON with a `session` and `weeklyAll` object.

Keep this running while the widget is in use. The bridge listens on `127.0.0.1` only and never exposes your token, only utilization percentages and reset timestamps.

**Optional — start at login (no console window):**

```powershell
cd bridge
./install-autostart.ps1
```

This registers a Windows scheduled task and writes `bridge/run-hidden.vbs` locally with paths for your machine. That file is not in the repo — do not edit it manually. Run `./install-autostart.ps1` again after cloning, after moving the project folder, or if you change Node install location or bridge port.

Remove autostart and the local launcher with `./uninstall-autostart.ps1`.

### 3. Import the widget

In iCUE, import `claude-usage.icuewidget` from the repository root and assign it to a Xeneon Edge tile.

### 4. Configure in iCUE

The widget's settings panel has three groups:

**Connection**

| Setting | Value |
|---------|-------|
| Bridge Port | `37650` (must match the running bridge) |
| Poll Interval (seconds) | `60` recommended |

**Display**

| Setting | Value |
|---------|-------|
| Max Model Rows | Number of per-model weekly rows to show (default `3`, max `8`) |

**Appearance**

| Setting | Value |
|---------|-------|
| Accent Color | Highlight color for bars and accents |
| Text Color | Primary text color |
| Background Color | Tile background color |

If port `37650` is already in use, start the bridge on a different port with `./start-bridge.ps1 -Port 37651` and set the same value in Bridge Port above.

## Troubleshooting

- **Bridge offline** — Run `bridge/start-bridge.ps1`
- **"Claude sign-in needed"** — Run `claude` on your PC to sign in again; your refresh token was rejected
- **Usage unavailable / rate limited** — Anthropic's usage endpoint is undocumented and rate-limited; the widget keeps showing the last good data (marked stale) and retries automatically
- **Widget shows old data or is blank** — Quit iCUE fully (tray), remove the widget, re-import `claude-usage.icuewidget`

## Forking / building from source

This is shared as-is for anyone who wants to fork it and change things. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and how the widget/bridge are put together.

## License

Licensed under the [MIT License](LICENSE).

Copyright (c) 2026 Jonathan
