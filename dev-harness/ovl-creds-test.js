// Proves the credential-source logic (3.1.19): macOS Keychain first with file
// fallback, both Keychain JSON shapes accepted, CLAUDE_CONFIG_DIR honored, cache
// busted by bustCredsCache(). Runs on any OS by faking process.platform and by
// stubbing child_process.execFile on the SHARED module object (extension.js holds
// a reference to the same object, so the patch reaches it).
const Module = require('module'); const origLoad = Module._load;
const path = require('path'); const fs = require('fs'); const os = require('os');

// vscode stub (minimal — we never activate, only require the module)
const vscode = { workspace:{ getConfiguration(){ return { get:()=>undefined }; } } };
Module._load = function(request){ if(request==='vscode') return vscode; return origLoad.apply(this, arguments); };

// Stub execFile BEFORE loading the extension is not needed (it captures the module
// object, not the function) — but patch before first use to be safe.
const cp = require('child_process');
const realExecFile = cp.execFile;
let secOut = null;      // what the fake `security` prints (null => simulate failure)
let secCalls = 0;
cp.execFile = function(cmd, args, opts, cb){
  if(cmd === 'security'){ secCalls++; return setImmediate(()=> cb(secOut===null ? new Error('not found') : null, secOut)); }
  return realExecFile.apply(this, arguments);
};

const ext = require(path.join(__dirname, '..', 'extension.js'));
const { readClaudeCreds, parseCreds, bustCredsCache } = ext._creds;

let pass=0, fail=0;
function ok(cond, name){ if(cond){pass++;} else {fail++; console.log('FAIL:', name);} }

// A scratch config dir with a known credentials file, used via CLAUDE_CONFIG_DIR
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-creds-'));
fs.writeFileSync(path.join(tmp, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken:'FILE_TOKEN', subscriptionType:'max', rateLimitTier:'t' } }));

const realPlatform = process.platform;
function setPlatform(p){ Object.defineProperty(process, 'platform', { value:p }); }

(async()=>{
  // 1-2. parseCreds accepts both shapes
  ok(parseCreds('{"claudeAiOauth":{"accessToken":"A","subscriptionType":"max"}}').token==='A', '1 wrapped shape');
  ok(parseCreds('{"accessToken":"B","subscriptionType":"max"}').token==='B', '2 bare shape');

  // 3. darwin: keychain wins (wrapped shape)
  setPlatform('darwin'); bustCredsCache(); secOut='{"claudeAiOauth":{"accessToken":"KC1"}}'; secCalls=0;
  ok((await readClaudeCreds()).token==='KC1', '3 keychain wrapped');

  // 4. cache: second read does NOT spawn security again
  const before=secCalls; await readClaudeCreds();
  ok(secCalls===before, '4 cached (no re-exec)');

  // 5. bustCredsCache forces a re-exec and picks up the new value (bare shape)
  bustCredsCache(); secOut='{"accessToken":"KC2"}';
  ok((await readClaudeCreds()).token==='KC2' && secCalls===before+1, '5 bust + bare shape');

  // 6. darwin + keychain failure -> file fallback via CLAUDE_CONFIG_DIR
  bustCredsCache(); secOut=null; process.env.CLAUDE_CONFIG_DIR=tmp;
  ok((await readClaudeCreds()).token==='FILE_TOKEN', '6 darwin fallback to file');

  // 7. keychain output that is garbage -> file fallback, no throw
  bustCredsCache(); secOut='not json at all';
  ok((await readClaudeCreds()).token==='FILE_TOKEN', '7 garbage keychain -> file');

  // 8. non-darwin: security never consulted, file only
  setPlatform('linux'); bustCredsCache(); secOut='{"accessToken":"KC3"}'; secCalls=0;
  const r8=await readClaudeCreds();
  ok(r8.token==='FILE_TOKEN' && secCalls===0, '8 non-darwin skips keychain');

  // 9. nothing anywhere -> {} (the nologin state), never a throw
  delete process.env.CLAUDE_CONFIG_DIR;
  // point HOME at an empty dir so the real ~/.claude file (if any) is not read
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-empty-'));
  process.env.CLAUDE_CONFIG_DIR = empty;
  bustCredsCache();
  const r9=await readClaudeCreds();
  ok(r9 && !r9.token, '9 no creds anywhere -> empty object');

  setPlatform(realPlatform);
  fs.rmSync(tmp,{recursive:true,force:true}); fs.rmSync(empty,{recursive:true,force:true});
  console.log(`creds: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
