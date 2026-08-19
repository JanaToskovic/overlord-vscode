// Unit tests for raise.js — run with: node test-raise.js
//
// These assert the SCRIPTS we generate, never their execution: the test suite
// has to pass on both platforms and on CI, where raising a window is meaningless.
// The Windows script is additionally parse-checked live by dev-harness/ovl-raise-parse.js.
const assert = require("assert");
const R = require("./raise");

// ---- quoting: a workspace name is user data and can contain anything --------
assert.strictEqual(R.psLit("CoS"), "'CoS'");
assert.strictEqual(R.psLit("Jana's"), "'Jana''s'", "PowerShell escapes a quote by doubling it");
assert.strictEqual(R.asLit("CoS"), '"CoS"');
assert.strictEqual(R.asLit('say "hi"'), '"say \\"hi\\""');
assert.strictEqual(R.asLit("a\\b"), '"a\\\\b"', "backslash is escaped before the quote");

// ---- Windows ----------------------------------------------------------------
const winAll = R.winScript("");
assert.ok(winAll.includes("Get-Process Code"), "no label -> every Code window");
assert.ok(!winAll.includes("EnumWindows($cb"), "no label -> no enumeration needed");

const winOne = R.winScript("CoS");
assert.ok(winOne.includes("EnumWindows"), "a label -> enumerate top-level windows");
assert.ok(winOne.includes("$wants = @('CoS')"), "the label is passed as a quoted literal");
// All VS Code windows share one process, so a Get-Process/MainWindowHandle
// approach can only ever see one of them. Guard against a regression to it.
assert.ok(!winOne.includes("MainWindowHandle"), "must not fall back to MainWindowHandle for a single window");
assert.ok(winOne.includes("GetWindowThreadProcessId"), "matches are restricted to Code's own windows");
assert.ok(winOne.includes("' - Visual Studio Code'"), "prefers VS Code's default title shape");
assert.ok(winOne.includes("IsIconic"), "a minimized window is restored first");
assert.ok(winOne.includes("AppActivate"), "foreground rights are claimed before SetForegroundWindow");
// injection: a quote in the workspace name must not escape the literal
const winEvil = R.winScript("a'; Remove-Item C:\\ -Recurse; #");
const evilLines = winEvil.split("\n").filter((l) => l.startsWith("$wants"));
assert.strictEqual(evilLines.length, 1, "no statement break escapes the literal");
assert.ok(evilLines[0].includes("a''; Remove-Item"), "the quote is doubled, i.e. neutralised");
assert.ok(/^\$wants = @\('.*'\)$/.test(evilLines[0]), "everything stays inside one quoted literal");

// ---- macOS ------------------------------------------------------------------
const macAll = R.macScript("");
assert.strictEqual(macAll, 'tell application "Visual Studio Code" to activate');

const macOne = R.macScript("FAI");
assert.ok(macOne.includes("AXRaise"), "a label -> raise that one window");
assert.ok(macOne.includes('name contains "FAI"'));
// The fallback is the whole reason this is shippable without Accessibility
// permission: System Events throws, and we still bring VS Code forward.
assert.ok(macOne.startsWith("try"), "the precise raise is attempted first");
assert.ok(macOne.includes("on error"), "and a failure is caught");
assert.ok(macOne.includes('tell application "Visual Studio Code" to activate'),
  "falling back to activating the app when Accessibility is not granted");
assert.ok(macOne.trimEnd().endsWith("end try"));
const macEvil = R.macScript('x" & (do shell script "rm -rf /") & "');
assert.ok(macEvil.includes('\\"'), "a quote in the label is escaped");
assert.ok(!/name contains "x" & \(do shell/.test(macEvil), "the injected quote does not close the literal");


// ---- several hints, because no single one always exists ---------------------
// A window with NO folder open publishes an empty title (seen live), so the
// workspace name cannot identify it. The terminal tab name, which lands in the
// title once the terminal is revealed, is the hint that works there.
assert.deepStrictEqual(R.normalizeHints(["  a ", "", "a", "b", null, 7]), ["a", "b"],
  "trimmed, de-duplicated, non-strings dropped");
assert.deepStrictEqual(R.normalizeHints(""), [], "nothing usable -> no hints");
assert.strictEqual(R.winScript([]), R.winScript(""), "no hints falls back to raising every window");
assert.strictEqual(R.macScript([]), 'tell application "Visual Studio Code" to activate');

const twoWin = R.winScript(["Ask me a question", "CoS"]);
assert.ok(twoWin.includes("$wants = @('Ask me a question', 'CoS')"), "hints are emitted in order");
assert.ok(twoWin.indexOf("foreach ($want in $wants)") > 0, "hints are tried in order, first match wins");
// The exact title shape must be preferred over a loose contains WITHIN one hint,
// or a hint matching some other window loosely would beat the right window.
assert.ok(twoWin.indexOf("' - Visual Studio Code')") < twoWin.indexOf("+ $want + '*')"),
  "exact title shape is tried before the loose contains");

const twoMac = R.macScript(["Ask me a question", "CoS"]);
assert.strictEqual((twoMac.match(/AXRaise/g) || []).length, 2, "one attempt per hint");
assert.ok(twoMac.indexOf('"Ask me a question"') < twoMac.indexOf('"CoS"'), "in order");
assert.strictEqual((twoMac.match(/on error/g) || []).length, 2, "each attempt has its own catch");
assert.ok(twoMac.includes('tell application "Visual Studio Code" to activate'),
  "and the innermost failure still brings VS Code forward");

console.log("PASS — raise.js: per-window scripts, quoting, macOS permission fallback");
