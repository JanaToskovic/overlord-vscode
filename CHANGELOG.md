# Changelog

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
