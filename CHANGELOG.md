# Changelog

## 3.1.1 — 2026-07-12
- **Fix**: terminals opened by a manually clicked launch pill now survive window reloads. They were marked non-restorable (correct only for auto-launch pills, which recreate themselves), so a reload silently orphaned any session started from a pill — alive on the board, no tab to type into. Auto-launch pills keep the old behavior to avoid duplicates.

## 3.1.0 — 2026-07-12
- **Terminal tab names survive window reloads.** Overlord remembers which name belongs to which session and, after a reload, re-applies your custom names to tabs that regressed to a default shell name. One brief focus pass right after reload; names you type post-reload are never overwritten. (Names start being remembered from this version on, so the first reload teaches it, the second one benefits.)
- **Workspace folder on every card.** The meta line now always leads with the session's folder: `my-project · opus-4.8 · ctx 59% · up 1h04m`.
- **Model badge moved to the meta line.** On red cards the long needs-you reason used to push the model off the edge; every fact now has a fixed position: folder · model · ctx · uptime.
- **Background sessions labeled.** A session spawned headless by another session (a reviewer subagent, a script) shows a `background` tag instead of offering a Jump that dead-ends in a terminal picker.
- **Detection: quoted text no longer counts as an ask.** Approval phrases inside quotation marks, code fences, blockquotes, or drafted blocks are the assistant talking *about* an ask, not asking — a shown draft reply kept a card falsely red for six hours. Genuine asks are unaffected, guarded by regression tests.

## 3.0.3 — 2026-07-10
The board grew up. This release merges a private fork by **DS** — launch pills, the live activity feed, card detail levels, and a hardened webview — with everything from the 2.x line, plus two resilience fixes born from real use.

- **Launch pills** (by DS): up to 3 configurable buttons above the board. Each opens an editor-area terminal in its own folder and types its own command. Configure via the ✎ pencil (`overlord.launcher1..3.{name, icon, cwd, command, autoLaunch}`); all slots ship empty. Auto-launch starts a session when VS Code opens. Pills run through your default shell profile on every OS.
- **Live activity feed** (by DS): cards expand to the session's recent actions — tool calls paired with their results (failures marked ✗), thinking, and the latest message. Click anywhere on a card to expand/collapse; the eye jumps to the terminal. `overlord.defaultDetail: compact | full | remember` — `remember` keeps each card's state across reloads. Hovering a card shows a full-detail native tooltip.
- **Richer telemetry** (by DS): status line shows state + elapsed + model + running subagents; the meta line shows context usage (honest "ctx 247k" when past the nominal window) and uptime.
- **Never a blank board**: a failed `claude agents` poll (the CLI briefly disappears during its own self-update, or spawns time out under load) no longer blanks the panel. The last good board stays up with a "reconnecting…" note, and even a hard outage keeps your sessions visible with the error as a note.
- **Stuck-"working" detection**: a session whose background shell never exits reports `busy` forever, hiding a question typed hours ago. If the transcript has been silent for 2+ minutes and the last message awaits you, the card flips to "needs you · typed a question · bg task running".
- **Webview hardening** (by DS): ready-handshake with a dead-UI warning, heartbeat, `window.onerror` surfaced into the panel, change-only DOM updates (native tooltips now actually appear), instant terminal-rename detection.
- **Detection tuning** (by DS): the routine closer "let me know if you'd like anything else" no longer flags a finished session as needing you.
- **Fixes from live testing**: jumping to a terminal no longer un-maximizes the window on Windows; the whole card is a click target, not just its text.
- **For 2.x users**: the ▸ chevron's expand gesture is now the card-wide click, cards start expanded by default (set `overlord.defaultDetail: compact` for the old density), and "+ New YOLO session" is superseded by the pills (the folder-picker lives on as the `Overlord: New Session` command and status-bar button).

## 2.2.2 — 2026-07-09
- **Fix**: 2.2.1 could not render the session board at all ("An error occurred while loading view"). A backtick inside a CSS comment closed the JavaScript template literal that builds the webview. The file still parsed, so no check caught it. Added `test-webview.js`, which walks each HTML template to its real closing backtick and fails if it is cut short.

## 2.2.1 — 2026-07-09
- **Fix**: the "you are here" accent never appeared on `needs you` cards. It was drawn with `box-shadow`, the same property the needs-you pulse animates, and a running animation overrides a normal declaration, so the marker was erased on exactly the cards you most need to locate. It now recolors the card's (otherwise unused) left border, which nothing animates. The tint is also stronger, so it reads at a glance.

## 2.2.0 — 2026-07-09
- **"You are here"**: the card for the session running in your focused terminal gets a subtle theme-native accent (left bar + faint tint), so you always know which session you're typing into. Follows real terminal focus — whether you got there via a card's jump link, by clicking the terminal tab, or with `Ctrl+\``. Expanding a card does not move it. The accent is state-neutral and never alters the needs-you / working / done / idle colors.
- **Much faster jumps**: clicking a card's action link used to scan every process on the machine synchronously, freezing the UI for up to a couple of seconds and swallowing clicks (hence the "click it two or three times"). The session-to-terminal mapping is now cached by the poll, so a jump is an instant lookup. The scan survives only as a fallback, and it no longer blocks.
- **Fix**: cards no longer momentarily lose their activity lines and latest message when the board re-renders outside a poll tick.

## 2.1.9 — 2026-07-09
- **Better "needs you" detection**: catches approval-question turns like "Good to proceed this way? If yes, I'll start…" that Agent View reports as idle. Extends the directive-question and go-ahead phrase sets ("proceed this way", "(good/ok) to proceed", "shall we", and the "if yes/so… I'll" trailing conditional), with regression coverage so unrelated statements stay quiet.

## 2.1.7 — 2026-07-07
- Refreshed listing description; no functional changes from 2.1.6.

## 2.1.6 — 2026-07-07
- **Expandable session cards**: click a card to expand it (▸/▾ chevron). Expanded cards show up to 7 recent activity lines with icons (🔧 Bash, ✏️ edits, 💭 thinking, 📄 reads), a 💬 preview of the session's latest message, and a state-aware action link (Answer now / Watch / Continue).
- **Richer card sub-line**: `state time · model · ctx tokens · % of context used · uptime` on every card.
- **New session launcher**: button in the panel header and status bar. Pick a folder and a fresh session opens as an editor-area terminal. Command is configurable via `overlord.newSessionCommand` (default `claude`).
- **Fix**: uptime ("up 3h45m") now renders — `claude agents --json` reports `startedAt` as epoch milliseconds, which previously parsed as NaN and hid the segment.
- **In-editor transcript viewer** (no card entry point; available via the `Overlord` commands): session output as an editor tab with line-numbered red/green diffs and live follow.

## 2.0.6 — 2026-07-06
- Directive-question detector: catches "want me to proceed…? <trailing statement>" turns that previously showed as idle.

## 2.0.3 — 2026-07-03
- First Marketplace release: session board with colored eyes, status-bar counter, activity-bar badge, sound + pop-up alerts, one-click jump to terminal, typed-question/approval detection for idle sessions.
