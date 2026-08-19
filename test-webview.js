// Guards the webview HTML templates in extension.js — run with: node test-webview.js
//
// The board and transcript views are built as JS template literals holding a
// whole HTML document. A stray backtick anywhere inside (easy to type in a CSS
// or JS comment: `.row.needs`) closes the literal early. The file still PARSES,
// so `node --check` and the unit tests stay green while the view is silently
// destroyed and VS Code shows "An error occurred while loading view".
// This test reads the source and proves each template reaches </html>.
const assert = require("assert");
const fs = require("fs");

const src = fs.readFileSync(require.resolve("./extension.js"), "utf8");
const OPEN = "`<!DOCTYPE html>";

// Walk from an opening backtick to the backtick that actually closes the
// literal, stepping over \` escapes and over ${ ... } substitutions (which may
// legitimately contain their own backticks).
function templateBody(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return src.slice(openIdx + 1, i);
    if (c === "$" && src[i + 1] === "{") {
      let depth = 1; i += 2;
      while (i < src.length && depth) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return null;   // unterminated
}

const opens = [];
for (let i = src.indexOf(OPEN); i !== -1; i = src.indexOf(OPEN, i + 1)) opens.push(i);
assert.ok(opens.length >= 1, "no webview HTML templates found — did the markers change?");

for (const idx of opens) {
  const line = src.slice(0, idx).split("\n").length;
  const body = templateBody(src, idx);
  assert.ok(body !== null, `unterminated HTML template literal at line ${line}`);
  assert.ok(
    body.includes("</html>"),
    `HTML template at line ${line} is cut short — a stray backtick closes it early. ` +
    `It ends with: ...${JSON.stringify(body.slice(-70))}`);
  assert.ok(!body.includes("<style></style>"), `empty style block at line ${line}`);
}

// The board template specifically must carry the pieces the UI depends on.
// Select it by a board-only marker: the transcript viewer also uses id="root".
const board = opens.map((i) => templateBody(src, i)).find((b) => b && b.includes(".row.needs"));
assert.ok(board, "board webview template not found");
for (const needle of ['id="launchers"', 'id="note"', ".row.here", "acquireVsCodeApi", 'type:"jump"', 'type:"cycleLevel"', 'type:"ready"',
  // usagePosition="bottom" home for the usage card: the CSS rule, the bottom slot, and
  // the client-side mover must all survive template edits.
  "#stickyfoot{", 'id="stickyfoot"', "placeUsage",
  // The single ⚙ settings button posts a plain openSettings (host opens ALL
  // Overlord settings — no "launcher" filter hiding the rest).
  'type:"openSettings"']) {
  assert.ok(board.includes(needle), `board template is missing ${needle}`);
}
// Exactly ONE #usage element: the usage card is a single div the webview reparents
// between #stickyhead and #stickyfoot (overlord.usagePosition). A second id="usage"
// would silently break getElementById-based rendering.
const usageCount = board.split('id="usage"').length - 1;
assert.strictEqual(usageCount, 1, `board template must contain exactly one id="usage" (found ${usageCount})`);
// The "you are here" accent must not use box-shadow: .row.needs animates it,
// and an animation overrides a normal declaration, hiding the accent.
const here = board.match(/\.row\.here\{[^}]*\}/);
assert.ok(here, ".row.here rule not found");
assert.ok(!/box-shadow/.test(here[0]), ".row.here must not set box-shadow (the needs pulse animates it)");

// ---- jumpAffordance: the card must never promise a destination it cannot reach.
// The function lives inside the webview template, so we lift the shipping source
// out and exercise it rather than testing a copy that could drift.
{
  const m = src.match(/function jumpAffordance\(s\)\{[\s\S]*?\n  \}/);
  assert.ok(m, "jumpAffordance not found in the board template");
  // eslint-disable-next-line no-new-func
  const ja = new Function(m[0] + "; return jumpAffordance;")();

  const here = ja({ winLoc: { where: "here", label: "" } });
  assert.strictEqual(here.txt, "Jump ↗");
  assert.strictEqual(here.show, true);

  const peer = ja({ winLoc: { where: "peer", label: "FAI" } });
  assert.strictEqual(peer.show, true, "a session in another window IS reachable now");
  assert.ok(peer.txt.includes("FAI"), "the card names the window, not 'another window'");
  assert.ok(peer.tip.includes("FAI"));

  const orphan = ja({ winLoc: { where: "none" }, bg: true });
  assert.strictEqual(orphan.show, true);
  assert.ok(!/Jump/.test(orphan.txt), "an orphan must not offer a Jump: there is nothing to jump to");
  assert.ok(/no terminal/i.test(orphan.tip));

  // No registry (older setup, or globalStorage unavailable): fall back exactly to
  // the previous behaviour rather than inventing a location.
  assert.strictEqual(ja({ winLoc: null, bg: true }).show, false, "headless with no registry: no Jump, as before");
  assert.strictEqual(ja({ winLoc: null, bg: false }).txt, "Jump ↗");
  // A peer label is unknown but present: still better than silence.
  assert.ok(ja({ winLoc: { where: "peer" } }).txt.includes("another window"));
}

console.log("PASS — webview templates intact (" + opens.length + " checked) + jump affordance");
