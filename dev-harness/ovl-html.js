// Structural + PARSE checks on the COOKED webview html (the actual html() output).
// The parse gate is the critical check: the webview script lives inside a template
// literal, so escapes like \n cook into raw characters - a mistake there produces
// html that LOOKS fine but whose script is a SyntaxError and silently never runs
// (exactly the 2.1.7..2.1.12 stuck-placeholder bug).
const { execFileSync } = require('child_process');
const vm = require('vm');
const extPath = process.argv[2] || require('path').join(__dirname,'..','extension.js');
const html = execFileSync(process.execPath, [__dirname + '/ovl-cooked.js', extPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
console.log('cooked html length:', html.length);
const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.log('FAIL: no <script> in cooked html'); process.exit(1); }
console.log('script length:', m[1].length);
try {
  new vm.Script(m[1], { filename: 'webview.js' });
  console.log('script PARSES: OK');
} catch (e) {
  console.log('FAIL: cooked script does not parse:', e.message);
  console.log(e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
}
// Structural invariants - hard-fail on violation (this is a gate, not a report).
let failed = false;
function check(name, ok) { console.log((ok ? 'ok  ' : 'FAIL') + ' - ' + name); if (!ok) failed = true; }
check('has acquireVsCodeApi', /acquireVsCodeApi/.test(m[1]));
check('has heartbeat', /Overlord loaded/.test(m[1]));
check('has ready post', /type:"ready"/.test(m[1]));
check('no stray ${ in html', (html.match(/\$\{/g) || []).length === 0);
// Guard the known silent-cook bug: \s in the template cooks to plain "s". The cooked
// script must contain the real whitespace regex. (vm.Script can't catch this - /s+/g
// parses fine but collapses the letter "s" instead of whitespace.)
check('collapse() has whitespace regex /\\s+/g', m[1].indexOf('replace(/\\s+/g') >= 0);
// Launchers (2.4.0): pill bar must live OUTSIDE #root (showEmpty wipes root.innerHTML -
// zero-sessions is exactly when launch pills matter most) and be rendered on every post.
check('has #launchers container', /id="launchers"/.test(html));
check('#launchers is outside (before) #root', html.indexOf('id="launchers"') >= 0 && html.indexOf('id="launchers"') < html.indexOf('id="root"'));
check('has renderLaunchers', /function renderLaunchers/.test(m[1]));
check('posts type:"launch"', /type:"launch"/.test(m[1]));
check('posts type:"openSettings" (pill cfg affordance)', /type:"openSettings"/.test(m[1]));
// Pill tooltip newlines: the COOKED script source must carry the 2-char \n ESCAPE
// (written \\n in the template). A raw newline here would be the 2.1.7 SyntaxError class;
// the escape becomes a real newline only at webview runtime (ovl-e2e asserts that side).
check('pill tooltip has \\n escape before In:', m[1].indexOf('\\nIn: ') >= 0 && m[1].indexOf('\nIn: ') < 0);
check('webview script is IIFE-wrapped', /^\s*\(function\s*\(\)\s*\{/.test(m[1]) && /\}\)\(\);?\s*$/.test(m[1]));
const csp = html.match(/Content-Security-Policy[^>]*/);
console.log('CSP:', csp ? csp[0].slice(0, 100) : 'none (intentional since 2.1.11)');
console.log('--- head ---'); console.log(html.slice(0, 200));
console.log('--- tail ---'); console.log(html.slice(-120));
// Detail panel html (second webview, same cooked-escape bug class) - parse-gate it too.
const dhtml = execFileSync(process.execPath, [__dirname + '/ovl-cooked.js', extPath, 'detail'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (dhtml) {
  const dm = dhtml.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!dm) { console.log('FAIL: no <script> in detail html'); process.exit(1); }
  try { new vm.Script(dm[1], { filename: 'detail.js' }); console.log('detail script PARSES: OK'); }
  catch (e) { console.log('FAIL: detail script does not parse:', e.message); process.exit(1); }
  check('detail: no stray ${ in html', (dhtml.match(/\$\{/g) || []).length === 0);
  if (failed) { console.log('GATE FAILED'); process.exit(1); }
} else {
  console.log('detail html: none (older extension) - skipped');
}
if (failed) { console.log('GATE FAILED'); process.exit(1); }
console.log('GATE PASSED');
process.exit(0);
