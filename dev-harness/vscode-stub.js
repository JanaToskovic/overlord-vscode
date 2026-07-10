// Shared `vscode` stub for the dev harnesses — the union of every vscode.* API
// the extension touches (grep both extension.js versions when extending).
// Intercepts require('vscode') via Module._load; call install() before
// requiring extension.js.
const Module = require("module");
const origLoad = Module._load;

function makeStub(overrides = {}) {
  const disposable = { dispose() {} };
  const term = {
    name: "stub-term", processId: Promise.resolve(0),
    show() {}, sendText() {}, dispose() {},
    shellIntegration: null,
  };
  const vscode = {
    workspace: {
      getConfiguration() { return { get: (k) => (k === "device.enabled" ? false : undefined), update: async () => {} }; },
      workspaceFolders: [],
    },
    window: {
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider(id, p) { vscode._p = p; return disposable; },
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
      createTerminal() { return { ...term }; },
      createWebviewPanel() {
        return { webview: { options: {}, html: "", onDidReceiveMessage: () => disposable, postMessage() {} },
                 onDidDispose: () => disposable, reveal() {}, dispose() {} };
      },
      onDidChangeActiveTerminal: () => disposable,
      activeTerminal: undefined,
      tabGroups: { onDidChangeTabs: () => disposable, all: [] },
      terminals: [],
    },
    commands: {
      registerCommand: () => disposable,
      executeCommand: async () => undefined,
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    TerminalLocation: { Panel: 1, Editor: 2 },
    ViewColumn: { Active: -1 },
    ThemeColor: function ThemeColor(id) { this.id = id; },
    Uri: { file: (p) => ({ fsPath: p, toString: () => "file://" + p }) },
    ConfigurationTarget: { Global: 1 },
  };
  return Object.assign(vscode, overrides);
}

function install(overrides) {
  const vscode = makeStub(overrides);
  Module._load = function (r) { return r === "vscode" ? vscode : origLoad.apply(this, arguments); };
  return vscode;
}

module.exports = { install, makeStub };
