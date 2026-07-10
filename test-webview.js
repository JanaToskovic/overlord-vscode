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
for (const needle of ['id="new"', ".row.here", "acquireVsCodeApi", 'type:"jump"']) {
  assert.ok(board.includes(needle), `board template is missing ${needle}`);
}
// The "you are here" accent must not use box-shadow: .row.needs animates it,
// and an animation overrides a normal declaration, hiding the accent.
const here = board.match(/\.row\.here\{[^}]*\}/);
assert.ok(here, ".row.here rule not found");
assert.ok(!/box-shadow/.test(here[0]), ".row.here must not set box-shadow (the needs pulse animates it)");

console.log("PASS — webview templates intact (" + opens.length + " checked)");
