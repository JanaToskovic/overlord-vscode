// Guards the status-bar quick toggles END TO END — run with: node test-statusbar.js
//
// test-agents.js covers what the buttons SAY (the pure A.statusToggle mapping).
// This covers that they are actually WIRED: created at the right priority, bound
// to a registered command, and repainted when the setting changes by any route.
// Without this, a typo in activate() ships a bar with no buttons and every unit
// test still passes.
const assert = require("assert");
const path = require("path");
const Module = require("module");

// ---- minimal vscode stub with a config store that really stores -------------
const store = { claudePath: "claude", pollMs: 2500, sound: true, currentWindowOnly: false,
                doneFlashSeconds: 12, detectTypedQuestions: true, "device.enabled": false,
                defaultDetail: "full", feedEvents: 6, usage: false, usagePosition: "top" };
const bars = [];      // every status bar item created, in creation order
const commands = {};  // id -> handler
let cfgListener = null;
const disposable = { dispose() {} };

const vscode = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (store[k] !== undefined ? store[k] : d),
      update: async (k, v) => {
        store[k] = v;
        if (cfgListener) cfgListener({ affectsConfiguration: (key) => key === "overlord." + k });
      },
    }),
    onDidChangeConfiguration: (fn) => { cfgListener = fn; return disposable; },
  },
  window: {
    createStatusBarItem(alignment, priority) {
      const item = { alignment, priority, text: "", tooltip: "", command: "",
                     backgroundColor: undefined, visible: false,
                     show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
      bars.push(item); return item;
    },
    registerWebviewViewProvider: (id, p) => { vscode._provider = p; return disposable; },
    onDidChangeActiveTerminal: () => disposable, activeTerminal: undefined,
    tabGroups: { onDidChangeTabs: () => disposable, all: [] },
    createTerminal: () => ({ name: "t", processId: Promise.resolve(0), show() {}, sendText() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { options: {}, html: "", onDidReceiveMessage: () => disposable, postMessage() {} },
                                 onDidDispose: () => disposable, reveal() {}, dispose() {} }),
    terminals: [], showWarningMessage: () => ({ then() {} }),
    showInformationMessage: () => ({ then() {} }), showQuickPick: () => Promise.resolve(null),
  },
  commands: {
    registerCommand: (id, fn) => { commands[id] = fn; return disposable; },
    executeCommand: () => Promise.resolve(),
  },
  TerminalLocation: { Panel: 1, Editor: 2 }, ViewColumn: { Active: -1 },
  Uri: { file: (p) => ({ fsPath: p, toString: () => "file://" + p }) },
  StatusBarAlignment: { Left: 1, Right: 2 }, ThemeColor: function () {},
  ConfigurationTarget: { Global: 1 },
};
const origLoad = Module._load;
Module._load = function (req) { if (req === "vscode") return vscode; return origLoad.apply(this, arguments); };

const ext = require(path.join(__dirname, "extension.js"));
ext.activate({ subscriptions: [] });

const byCommand = (c) => bars.find((b) => b.command === c);
const sound = byCommand("overlord.toggleSound");
const win = byCommand("overlord.toggleCurrentWindowOnly");

assert.ok(sound, "no status-bar item bound to overlord.toggleSound");
assert.ok(win, "no status-bar item bound to overlord.toggleCurrentWindowOnly");
console.log("ok - both toggle buttons are created and bound to a command");

// Both commands must actually be registered, or the button is a dead click.
for (const c of ["overlord.toggleSound", "overlord.toggleCurrentWindowOnly"]) {
  assert.strictEqual(typeof commands[c], "function", c + " is not registered");
}
console.log("ok - both commands are registered");

// Position: right-aligned, and between the session summary (100) and New Session (99),
// so they land where the design put them rather than at the far end of the bar.
for (const [name, item] of [["sound", sound], ["window", win]]) {
  assert.strictEqual(item.alignment, vscode.StatusBarAlignment.Right, name + " is not right-aligned");
  assert.ok(item.priority < 100 && item.priority > 99,
    `${name} priority ${item.priority} is not between the summary (100) and New Session (99)`);
  assert.ok(item.visible, name + " button was never shown");
}
console.log("ok - both sit between the session summary and New Session, and are visible");

// Painted from the CURRENT setting, not a hardcoded default.
assert.strictEqual(sound.text, "$(unmute)", "sound starts ON, so it should show unmute");
assert.strictEqual(win.text, "$(multiple-windows)", "window filter starts OFF, so it should show multiple-windows");
assert.ok(sound.tooltip && win.tooltip, "tooltips must be set on activate, not only after a click");
console.log("ok - initial icons match the current settings");

(async () => {
  // Clicking must flip the setting AND repaint the icon.
  await commands["overlord.toggleSound"]();
  assert.strictEqual(store.sound, false, "clicking the sound button did not flip the setting");
  assert.strictEqual(sound.text, "$(mute)", "sound icon did not repaint after the click");
  await commands["overlord.toggleSound"]();
  assert.strictEqual(store.sound, true);
  assert.strictEqual(sound.text, "$(unmute)", "sound icon did not repaint back");

  await commands["overlord.toggleCurrentWindowOnly"]();
  assert.strictEqual(store.currentWindowOnly, true, "clicking the window button did not flip the setting");
  assert.strictEqual(win.text, "$(window)", "window icon did not repaint after the click");
  console.log("ok - clicking flips the setting and repaints the icon, both ways");

  // Changed from the settings page instead of the button: same repaint, or the
  // bar silently lies about the current state.
  store.sound = false;
  cfgListener({ affectsConfiguration: (k) => k === "overlord.sound" });
  assert.strictEqual(sound.text, "$(mute)", "icon did not follow a settings-page change");
  console.log("ok - icons follow a change made outside the button");

  // Every command the manifest declares must exist, and vice versa.
  const declared = require("./package.json").contributes.commands.map((c) => c.command);
  for (const c of declared) assert.ok(commands[c], "declared but not registered: " + c);
  for (const c of Object.keys(commands)) assert.ok(declared.includes(c), "registered but not declared: " + c);
  console.log("ok - declared commands and registered commands match exactly");

  // ---- settings manifest ----------------------------------------------------
  // Settings are contributed as SIX titled groups so the Settings UI nests them
  // under Overlord instead of showing one flat wall of 28. Regrouping is a
  // copy-paste-heavy edit on a big JSON block, so guard the invariants that a
  // slip would break silently.
  const conf = require("./package.json").contributes.configuration;
  assert.ok(Array.isArray(conf), "configuration must be an ARRAY of titled groups, or the tree stays flat");
  const seenKeys = new Set(), seenTitles = new Set();
  for (const group of conf) {
    assert.ok(group.title && group.title.trim(), "every group needs a title, it is the node in the tree");
    assert.ok(!seenTitles.has(group.title), "duplicate group title: " + group.title);
    seenTitles.add(group.title);
    const keys = Object.keys(group.properties || {});
    assert.ok(keys.length >= 2, `group "${group.title}" has ${keys.length} setting(s); a one-item node is not worth a click`);
    const orders = keys.map((k) => group.properties[k].order);
    assert.strictEqual(new Set(orders).size, orders.length,
      `group "${group.title}" has duplicate order values, so its settings sort arbitrarily`);
    for (const k of keys) {
      assert.ok(!seenKeys.has(k), "setting declared in two groups: " + k);
      seenKeys.add(k);
    }
  }
  console.log(`ok - ${conf.length} settings groups, ${seenKeys.size} settings, no duplicates or orphans`);

  // Every setting the CODE reads must be declared, or it silently falls back to
  // undefined and the Settings UI never offers it. This is what would catch a
  // setting dropped during a regrouping.
  const srcAll = require("fs").readFileSync("./extension.js", "utf8");
  const read = new Set();
  for (const m of srcAll.matchAll(/cfg\(\)\.get\(\s*"([a-zA-Z0-9_.]+)"/g)) read.add("overlord." + m[1]);
  assert.ok(read.size >= 8, "expected to find several cfg().get() reads, found " + read.size);
  for (const k of read) assert.ok(seenKeys.has(k), "extension.js reads " + k + " but package.json does not declare it");
  console.log(`ok - all ${read.size} settings read by extension.js are declared in the manifest`);

  console.log("PASS — status-bar toggles wired correctly");
  process.exit(0);
})();
