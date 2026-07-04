# Overlord 👁️ — install

A live board of your Claude Code sessions inside VS Code: one colored eye per
session (🔴 needs you / 🟡 working / 🟢 done / ⚪ idle), a status-bar counter,
alerts, and one-click jump to the terminal. Works on Windows and macOS.

Overlord reads Claude Code's own session supervisor (`claude agents --json`).
There are **no hooks and nothing to configure** — just install it.

## Requirements

- VS Code
- The [Claude Code CLI](https://claude.com/claude-code) on your `PATH`, **v2.1.x or newer** (the `agents` command). Check with `claude --version`.

## Install

1. Install the extension:
   ```
   code --install-extension overlord-2.0.1.vsix
   ```
   (or in VS Code: Extensions → **…** → *Install from VSIX…*)
2. Reload VS Code: `Ctrl+Shift+P` → *Developer: Reload Window*.
3. Click the 👁 eye in the Activity Bar. Any `claude` session you have running in
   a terminal shows up within a couple of seconds, labelled with its terminal tab.

That's it.

## If the eye stays empty

The extension host must be able to run `claude`. If it can't find it on your
`PATH`, set the full path: open Settings (`Ctrl+,`), search **overlord.claudePath**,
and set it to your `claude` binary (find it with `which claude` / `where claude`).

The board also shows the exact error it hit (e.g. "couldn't run `claude agents`")
so you know what to fix.

## Settings (Settings → search "overlord")

| Setting | Default | What it does |
|---|---|---|
| `overlord.claudePath` | `claude` | command/path used to run the CLI |
| `overlord.pollMs` | `2500` | how often to poll `claude agents --json` (ms) |
| `overlord.sound` | `true` | soft notification sound on "needs you" |
| `overlord.notifications` | `true` | pop-up alerts |
| `overlord.doneFlashSeconds` | `12` | how long the green "done" flash lasts |

Toggle sound anytime: `Ctrl+Shift+P` → **Overlord: Toggle Sound**.
