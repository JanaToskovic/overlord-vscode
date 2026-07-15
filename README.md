# Overlord 👁️

A live board of your [Claude Code](https://claude.com/claude-code) sessions, right inside VS Code. One colored eye per session so you always know which one needs you, which is working, and which just finished — with a live activity feed per card, configurable launch pills, a marker for the session you're typing in, and one-click jump to the exact terminal. Works on Windows and macOS.

> **Beta.** An early release, live on the VS Code Marketplace and auto-updating. Expect a few rough edges and frequent improvements. Feedback very welcome 🙏

![Overlord — a live board of your Claude Code sessions in VS Code](media/board_vscode.png)

## Why Overlord?

**Isn't this just Agent View?** Overlord is *built on* Claude Code's Agent View, and adds what it's missing for people living in the terminal:

- **Catches what Agent View calls "idle."** A session that typed you a question or said "say go and I'll…" shows as plain idle in Agent View. Overlord flags it red: *needs you*.
- **Visible when VS Code isn't.** Status-bar counter, activity-bar badge, and a soft sound, so you're alerted even with the panel closed or VS Code buried.
- **Tells you where you are.** With half a dozen sessions open, the card for the one in your focused terminal is marked, so you always know which session you're typing into.
- **One-click jump** to the exact terminal tab.

*Built for Claude Code running in your VS Code terminal, not the Claude chat extension.*

## What it does

- **Eye icon** in the Activity Bar → opens the session board.
- **One eye per session**, colored by status:
  - 🔴 **Needs you** (pulsing) · 🟡 **Working** · 🟢 **Done** (brief) · ⚪ **Idle**
- **Status-bar counter** — `👁 🔴2 🟡3 🟢1`, turns red when a session needs you. Click to open the board.
- **Count badge** on the Activity Bar icon — how many sessions are waiting on you, even with the panel closed.
- **A soft notification sound** when a session needs your answer. The left-panel cards are the visual channel (no pop-ups). Once you've looked at a waiting session — jumped to it, focused its terminal, or opened its transcript — its card stops pulsing and greys out but keeps its "needs you" text, and sinks below your working sessions until it needs you again.
- **Click any eye** → jumps straight to that session's terminal (labelled with the terminal's tab name). For a **background/headless session** (no terminal of its own), the eye opens that session's transcript instead.
- **Live activity feed** (v3) — click anywhere on a card to expand it: recent tool calls paired with their results (failures marked ✗), 💭 thinking, and the 💬 latest message. The eye jumps to the terminal; hovering shows a full-detail tooltip. `overlord.defaultDetail: compact | full | remember` ("remember" keeps each card's state across reloads).
- **Session telemetry** (v3) — `state + elapsed · model · subagents` on the status line, `ctx usage · uptime` beneath it. Context past the nominal window shows the real token count instead of a misleading percentage.
- **Launch pills** (v3) — up to 3 configurable buttons above the board. Each opens an editor-area terminal in its own folder and types its own command (e.g. `claude`, or your own alias). Configure via the ✎ pencil; slots ship empty; optional auto-launch on VS Code start.
- **"You are here"** (v2.2) — the card whose session runs in your focused terminal lights up with a thick blue bar, tint, and bright name, so you always know which session you're typing into (it stands out even when that card has been greyed as "seen").
- **Claude usage** (v3.1.7, opt-in) — a card pinned at the top showing your live session (5h) and weekly limits, including per-model buckets, exactly like the Claude settings Usage panel. Colours by severity, with reset countdowns. Off by default; enable it from the invite card on the board or via `overlord.usage`. When on it reads your local Claude login and does one plain usage read a minute (0 tokens, not an AI call) — see Privacy below.
- **Terminal tab names restored** (v3.1) — VS Code resets custom terminal tab names on every window reload; Overlord remembers them and puts them back.
- **New session command** — `Overlord: New Session` (also a status-bar button): pick a folder, and a fresh session opens as an editor-area terminal (`overlord.newSessionCommand`, default `claude`).
- **Resilient board** (v3) — a failed poll never blanks the panel: the last good board stays up with a "reconnecting…" note. Sessions stuck `busy` on a dangling background shell flip to "needs you" when their last message awaits your answer.

## How it works

Overlord is built on Claude Code's own **Agent View**. It polls

```
claude agents --json
```

every couple of seconds and paints an eye per session. There are **no hooks and no state files** — the status comes straight from Claude Code's session supervisor.

**Status mapping** (`status` field from `claude agents --json`):

| Native status | Eye | Notes |
|---|---|---|
| `waiting` | 🔴 Needs you | a permission prompt or an interactive question; subtitle shows `waitingFor` |
| `busy` | 🟡 Working | |
| `idle` | ⚪ Idle | finished, nothing pending |
| _(derived)_ | 🟢 Done | brief green flash when a session goes `busy → idle`; see `overlord.doneFlashSeconds` |

**Beyond native — turns that quietly need you.** Agent View reports `idle` both when a session *finishes* and when it *ends its turn waiting on you* — it can't tell them apart. Overlord adds one check: for `idle` sessions it peeks the transcript's last message and, if the session is actually waiting on you, shows 🔴 instead of grey. It catches two shapes `claude agents` alone misses:

- a **genuine typed question** → subtitle **"needs you · typed a question"**. The check ignores trailing asides, so a real question followed by a parenthetical or an option list still counts, while a rhetorical question the assistant answers itself does not.
- an **approval / go-ahead request** with no question mark — "say go and I'll…", "give me the green light", "let me know which…" → subtitle **"needs you · awaiting your reply"**.

This is the thing Overlord catches that `claude agents` alone does not. Toggle with `overlord.detectTypedQuestions` (default on).

Each record also carries the live `claude` process `pid`. Overlord walks the process tree from it to label each eye with its **VS Code terminal tab** and to **jump** to that terminal on click.

**Cost:** each poll spawns the CLI (~0.5s). The interval is configurable (`overlord.pollMs`, default 2500 ms); lower values feel snappier but use more CPU. This is a deliberate trade for zero setup — no hooks to install.

## Install

**From the VS Code Marketplace** (recommended; installs update automatically). Pick whichever is easiest:

- **Page:** open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=jana81000.overlord-vscode) and click **Install**.
- **In VS Code:** press `Ctrl+P`, then run `ext install jana81000.overlord-vscode`.
- **In a terminal:** run `code --install-extension jana81000.overlord-vscode`.

Then reload VS Code.

Requires the [Claude Code CLI](https://claude.com/claude-code) on your `PATH` (the `agents` command needs CLI v2.1.x or newer). If the extension host can't find `claude`, set `overlord.claudePath` to the full path to the binary. See [INSTALL.md](INSTALL.md).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `overlord.claudePath` | `claude` | command/path used to run the CLI |
| `overlord.pollMs` | `2500` | how often to poll `claude agents --json` (ms) |
| `overlord.sound` | `true` | soft notification sound on "needs you" |
| `overlord.usage` | `false` | show your Claude usage limits pinned on top (opt-in; reads your local login + one usage read/min, 0 tokens — see Privacy) |
| `overlord.doneFlashSeconds` | `12` | how long the green "done" flash lasts |
| `overlord.detectTypedQuestions` | `true` | flag idle sessions whose last message is a typed question or an approval/go-ahead request as "needs you" |
| `overlord.defaultDetail` | `full` | how cards start: `compact`, `full`, or `remember` (per-session, survives reloads) |
| `overlord.feedEvents` | `6` | max activity events on an expanded card (1-20) |
| `overlord.launcher1..3.*` | *(empty)* | launch pills: `name`, `icon`, `cwd` (`~` ok), `command`, `autoLaunch`. A pill exists once its command is non-empty |
| `overlord.device.enabled` | `false` | **opt-in.** mirror the board to an Overlord hardware screen on your LAN (starts a local server + discovery beacon). Off unless you have the companion screen. |
| `overlord.device.port` | `7331` | TCP port the hardware screen connects to |

Toggle sound anytime: **Overlord: Toggle Sound**. To use your own sound, replace `media/notify.wav` with any `.wav` (regenerate with `python make_sounds.py`).

## Privacy

By default, everything is local. Overlord runs `claude agents --json` on your machine and reads the result; no network calls, no telemetry. The data is only session ids, working directories, statuses, and process ids on your own machine.

The **one exception is the opt-in usage card** (`overlord.usage`, off by default). When you turn it on, Overlord reads your Claude login token from `~/.claude/.credentials.json` locally and makes one request a minute to `https://api.anthropic.com/api/oauth/usage` — a plain usage read (0 tokens, not an AI/inference call) that returns the same numbers as the Claude settings Usage panel. Your token is sent only to Anthropic's own API as the `Authorization` header, nothing else leaves your machine, and no data is sent anywhere else. Turn the card off (the ✕ on it, or the setting) and Overlord makes no network calls at all.

## Development

- `agents.js` — pure, dependency-free logic: display model, needs-you detection, feed parsing, telemetry. Unit-tested in `test-agents.js` (`node test-agents.js`).
- `extension.js` — the VS Code shell: polling, the webview, launch pills, process-tree resolution, and sound.
- `test-webview.js` — walks each webview HTML template to its true closing backtick (a stray backtick in the template cooks into a dead panel that `node --check` cannot see).
- `dev-harness/` — headless harnesses (see its README): cooked-HTML parse gate (`ovl-html.js`), DOM-mock render scenarios (`ovl-dom-test.js`), e2e replay of real host posts (`ovl-e2e.js`), activation and host-path tests. Run each with `node dev-harness/<file>.js`.

## License

MIT — see [LICENSE](LICENSE).
