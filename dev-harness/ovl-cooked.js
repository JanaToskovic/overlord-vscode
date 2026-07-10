// Prints the COOKED webview HTML (the actual html() output) to stdout.
// The webview script lives inside a template literal in extension.js, so escape
// sequences like \n and \s are transformed ("cooked") when html() runs. Testing
// the raw source text instead of this output is how the 2.1.7 SyntaxError
// (.join("\n") cooking to a raw newline inside a string literal) went undetected.
// Usage: node ovl-cooked.js [path-to-extension.js]
const { install } = require('./vscode-stub');
let captured = '';
const vscode = install();
const ext = require(process.argv[2] || require('path').join(__dirname,'..','extension.js'));
ext.activate({ subscriptions: [] });
// Second mode: `node ovl-cooked.js <ext> detail` prints the Detail panel html instead.
if (process.argv[3] === "detail") {
  process.stdout.write(typeof ext.detailHtml === "function" ? ext.detailHtml() : "");
  process.exit(0);
}
const fakeView = { webview: { options: {}, set html(v) { captured = v; }, onDidReceiveMessage() {}, postMessage() {} } };
vscode._p.resolveWebviewView(fakeView);
process.stdout.write(captured);
process.exit(0);
