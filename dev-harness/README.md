# Dev Harnesses — headless testing for the Overlord extension

`extension.js` does `require("vscode")` and can't run under plain Node, and the webview script runs in an iframe. These harnesses reproduce both sides headlessly (Node + a `vscode` stub + a DOM mock) so you can catch runtime bugs `node --check` (syntax only) misses. Run each with `node dev-harness/<file>.js`.

**THE rule (learned the hard way, v2.1.7–2.1.12):** the webview script lives inside a JS **template literal** in `extension.js`, so escapes are COOKED when `html()` runs — `\n` in source becomes a raw newline in the emitted script (SyntaxError → script silently never runs), `\s` becomes plain `s` (silent regex corruption). Every backslash in webview code must be written `\\`. **Always test the cooked `html()` output, never the raw source text** — that source-vs-cooked gap is how the stuck-placeholder bug stayed invisible for three days of green harness runs.

| Harness | What it proves |
|---|---|
| `ovl-cooked.js` | Prints the COOKED webview HTML (the actual `html()` output) to stdout. Building block for the others; `node ovl-cooked.js [extension.js path]`. |
| `ovl-html.js` | **Gate.** `vm.Script`-parses the cooked script (catches cooked SyntaxErrors) + hard-fails structural invariants: `acquireVsCodeApi`, heartbeat, ready-post, no stray `${}`, and the cooked `/\s+/g` whitespace regex (the known silent-cook bug vm can't catch). Exits 1 on any violation. |
| `ovl-e2e.js` | **Most useful.** Stubs `vscode`, runs the real `activate()` → `refresh()` against your live `claude` sessions, captures the posts, then replays them through the COOKED webview `<script>` (parse-gated) in a DOM mock. If host→post→render works on real data, this prints `RENDER of real posts: OK, root children=N`. |
| `ovl-dom-test.js` | Runs the COOKED webview `<script>` (via `ovl-cooked.js` subprocess, parse-gated) in a DOM mock against sample sessions across 8 render scenarios (reorder, grow, remove, error, recover). Catches `insertBefore`/reorder bugs. |
| `ovl-activate-test.js` | Runs `activate()` + `resolveWebviewView()` with a `vscode` stub; prints what got posted (or the throw). Confirms the host side posts sessions. |
| `ovl-host-test.js` | Runs just the pure data path (`readTailLines` + `recentEvents`) against live transcripts. No vscode stub. |

**Key limitation:** Node's `vm.Script` and the DOM mock are not Chromium/Electron — they don't replicate the real webview iframe, CSP enforcement, or the exact JS engine version. For changes touching the webview HTML/script shape, additionally load the cooked HTML in a real Chromium (serve it over localhost, stub `acquireVsCodeApi` before the main script, post a synthetic `{type:"sessions"}` message) — that is what actually proved the 2.1.13 fix.

The `vscode` stub trick: intercept `require('vscode')` via `Module._load` override, return a fake object implementing `workspace.getConfiguration`, `window.createStatusBarItem/registerWebviewViewProvider/terminals`, `StatusBarAlignment`, `ThemeColor`, `ConfigurationTarget`, `commands.registerCommand`. See any of the `*-test.js` files.
