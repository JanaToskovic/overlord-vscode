// Proves the credential-source logic (3.1.19+): macOS Keychain first (current user's
// account, then any item) with file
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
let secOut = null;      // what the fake `security` prints (null => simulate failure);
                        // a function receives the args and returns the output for that call
let secCalls = 0;
let secArgs = [];       // args of every fake `security` call, in order
cp.execFile = function(cmd, args, opts, cb){
  if(cmd === 'security'){
    secCalls++; secArgs.push(args);
    const out = typeof secOut === 'function' ? secOut(args) : secOut;
    return setImmediate(()=> cb(out===null ? new Error('not found') : null, out));
  }
  return realExecFile.apply(this, arguments);
};
// account the fake `security` was asked for (-a <acct>), or '' for a bare read
function acctOf(args){ const i = args.indexOf('-a'); return i >= 0 ? args[i+1] : ''; }
const me = os.userInfo().username;

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

  // 10-13. two Keychain items share the service name: the current user's account
  // (written by Claude Code, holds the login) and a loginless one (e.g. acct
  // "unknown" with only mcpOAuth) that a bare read happens to return first.
  setPlatform('darwin'); process.env.CLAUDE_CONFIG_DIR = empty;
  const LOGIN = '{"claudeAiOauth":{"accessToken":"MINE"},"mcpOAuth":{}}';
  const NOLOGIN = '{"mcpOAuth":{"x|1":{}}}';
  bustCredsCache(); secCalls=0; secArgs=[];
  secOut = (args) => acctOf(args) === me ? LOGIN : NOLOGIN;
  const r10 = await readClaudeCreds();
  ok(r10.token==='MINE', '10 account-scoped read wins over the loginless first item');
  ok(secCalls===1 && acctOf(secArgs[0])===me, '11 current user account is tried first, one exec');

  // 12. no item under the current account (e.g. written under another name) -> bare read
  bustCredsCache(); secCalls=0; secArgs=[];
  secOut = (args) => acctOf(args) === me ? null : '{"accessToken":"OTHER"}';
  const r12 = await readClaudeCreds();
  ok(r12.token==='OTHER' && secCalls===2 && acctOf(secArgs[1])==='', '12 falls back to the bare read');

  // 13. account item exists but has no login -> bare read still consulted
  bustCredsCache(); secCalls=0; secArgs=[];
  secOut = (args) => acctOf(args) === me ? NOLOGIN : '{"accessToken":"BARE"}';
  const r13 = await readClaudeCreds();
  ok(r13.token==='BARE' && secCalls===2 && acctOf(secArgs[1])==='', '13 loginless account item -> bare read');

  // 14. nothing under either -> file fallback, no throw
  bustCredsCache(); secOut = () => null; process.env.CLAUDE_CONFIG_DIR = tmp;
  ok((await readClaudeCreds()).token==='FILE_TOKEN', '14 both keychain reads fail -> file');

  // 15. os.userInfo() throws (no resolvable user) -> single bare read, as before the fix
  const realUserInfo = os.userInfo; os.userInfo = () => { throw new Error('no user'); };
  bustCredsCache(); secCalls=0; secArgs=[]; secOut = '{"accessToken":"BARE2"}';
  const r15 = await readClaudeCreds(); os.userInfo = realUserInfo;
  ok(r15.token==='BARE2' && secCalls===1 && acctOf(secArgs[0])==='', '15 userInfo throws -> one bare read');

  setPlatform(realPlatform);
  fs.rmSync(tmp,{recursive:true,force:true}); fs.rmSync(empty,{recursive:true,force:true});
  console.log(`creds: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
