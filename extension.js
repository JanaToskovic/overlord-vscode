// Overlord — a live board of your Claude Code sessions inside VS Code.
//
// Data source: `claude agents --json`, Claude Code's own session supervisor.
// No hooks, no state files — install the extension and it works. Each session
// becomes a colored eye:
//   waiting -> red "needs you"   busy -> amber "working"   idle -> grey "idle"
// A short green "done" flash marks a session that just went busy->idle (the only
// client-derived cue; every other state comes straight from Claude Code).
//
// The pid in each record is the live `claude` process, so we walk the process
// tree from it to (a) label each eye with its VS Code terminal tab and (b) jump
// straight to that terminal on click.

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const A = require("./agents");
const D = require("./device");
const { raiseVSCodeWindow } = require("./raise");

let provider;      // OverlordViewProvider
let statusItem;    // status-bar pill
let timer;         // poll interval
let polling = false;           // guard: never overlap slow polls
let seeded = false;            // suppress notifications on the first read
let prevStatus = {};           // sid -> last raw status (busy/waiting/idle)
let finishedAt = {};           // sid -> ms when it last went busy->idle
let lastError = null;          // last spawn error (for the empty state)
let procCache = { at: 0, map: null };
let termNames = new Map();      // sid -> resolved terminal tab name
let termResolveAt = 0;
let _agentCache = [];           // most recent raw records (for jump lookups)

function cfg() { return vscode.workspace.getConfiguration("overlord"); }

// ---- data: `claude agents --json` ------------------------------------------
function getAgents() {
  return new Promise((resolve) => {
    const bin = cfg().get("claudePath") || "claude";
    cp.exec(`"${bin}" agents --json`,
      { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, err });
        try { resolve({ ok: true, agents: A.parseAgents(stdout) }); }
        catch (e) { resolve({ ok: false, err: e }); }
      });
  });
}

function buildSessions(agents, now) {
  const doneFlashMs = (cfg().get("doneFlashSeconds") || 12) * 1000;
  return agents
    .map((a) => A.toSession(a, {
      finishedAtMs: finishedAt[a.sessionId], nowMs: now, doneFlashMs,
      termName: termNames.get(a.sessionId),
    }))
    .sort((x, y) => (A.ORDER[x.state] - A.ORDER[y.state]) || x.name.localeCompare(y.name));
}

// Claude Code reports `idle` both for "finished" and for "ended the turn
// needing you" — a typed question, or an approval/go-ahead request ("say go
// and I'll…"). The supervisor can't tell them apart, so for idle sessions we
// peek the transcript's last assistant message and, if it awaits you, surface
// why. Off via `overlord.detectTypedQuestions: false`.
const _tPath = new Map();   // sid -> resolved transcript path (paths are stable)
function transcriptPath(sid) {
  if (_tPath.has(sid)) return _tPath.get(sid);
  let found = null;
  try {
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, sid + ".jsonl");
      if (fs.existsSync(p)) { found = p; break; }
    }
  } catch (_) { /* projects dir missing -> no transcript */ }
  if (found) _tPath.set(sid, found);   // only cache hits, so late-created ones resolve later
  return found;
}
// Returns a short reason the idle session needs you ("typed a question" /
// "awaiting your reply"), or null if it's genuinely finished.
function idleAwaitReason(sid) {
  try {
    const p = transcriptPath(sid);
    if (!p) return null;
    const fd = fs.openSync(p, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);   // read the tail only
      return A.awaitReason(A.lastAssistantText(buf.toString("utf8")));
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// ---- process tree (terminal labelling + jump) ------------------------------
function getProcMap() {
  if (procCache.map && Date.now() - procCache.at < 4000) return procCache.map;
  const map = new Map();
  try {
    if (process.platform === "win32") {
      const out = cp.execFileSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
        { encoding: "utf8", timeout: 4000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) map.set(Number(m[1]), Number(m[2]));
      }
    } else {
      const out = cp.execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 4000 });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) map.set(Number(m[1]), Number(m[2]));
      }
    }
  } catch (_) { /* leave empty -> fall back to cwd matching */ }
  procCache = { at: Date.now(), map };
  return map;
}

function ancestorsOf(pid, map) {
  const set = new Set();
  let p = Number(pid), guard = 0;
  while (p && p > 1 && !set.has(p) && guard++ < 40) { set.add(p); p = map.get(p); }
  return set;
}

// Resolve each session to the VS Code terminal it runs in and remember the tab
// name, so sessions sharing a cwd stay distinguishable. Throttled.
async function resolveTermNames(sessions) {
  if (Date.now() - termResolveAt < 3000) return;
  termResolveAt = Date.now();
  const terms = vscode.window.terminals;
  if (!terms.length) return;
  const map = getProcMap();
  if (!map.size) return;
  const tpids = [];
  for (const t of terms) {
    let pid; try { pid = await t.processId; } catch (_) { pid = undefined; }
    if (pid) tpids.push({ pid, name: t.name });
  }
  let changed = false;
  for (const s of sessions) {
    if (!s.pid) continue;
    const anc = ancestorsOf(s.pid, map);
    const hit = tpids.find((tp) => anc.has(tp.pid));
    if (hit && termNames.get(s.sid) !== hit.name) { termNames.set(s.sid, hit.name); changed = true; }
  }
  if (changed && provider) provider.post(buildSessions(_agentCache, Date.now()));
}

async function jumpToTerminal(session) {
  const terms = vscode.window.terminals;
  if (!terms.length) {
    vscode.window.showInformationMessage("Overlord: no open terminals in this window.");
    return;
  }
  if (session.pid) {
    const map = getProcMap();
    if (map.size) {
      const anc = ancestorsOf(session.pid, map);
      for (const t of terms) {
        let tpid; try { tpid = await t.processId; } catch (_) { tpid = undefined; }
        if (tpid && anc.has(tpid)) { t.show(false); return; }
      }
    }
  }
  if (session.cwd) {
    const want = session.cwd.replace(/[\\/]+$/, "").toLowerCase();
    for (const t of terms) {
      const c = t.shellIntegration && t.shellIntegration.cwd && t.shellIntegration.cwd.fsPath;
      if (c && c.replace(/[\\/]+$/, "").toLowerCase() === want) { t.show(false); return; }
    }
  }
  if (terms.length === 1) { terms[0].show(false); return; }
  const pick = await vscode.window.showQuickPick(
    terms.map((t, i) => ({ label: t.name || ("Terminal " + (i + 1)), t })),
    { placeHolder: "Couldn't auto-locate " + session.name + " — pick its terminal" });
  if (pick) pick.t.show(false);
}

// A tap on the screen: reveal the session's terminal AND raise the VS Code
// window (best-effort). Looks the session up in the freshest built model.
function handleDeviceJump(sid) {
  const s = buildSessions(_agentCache, Date.now()).find((x) => x.sid === sid);
  if (!s) return;
  jumpToTerminal(s);
  raiseVSCodeWindow();
}

// ---- sound -----------------------------------------------------------------
function playSound() {
  if (!cfg().get("sound")) return;
  const wav = path.join(__dirname, "media", "notify.wav");
  let haveWav = false; try { haveWav = fs.existsSync(wav); } catch (_) {}
  try {
    if (process.platform === "win32") {
      const ps = haveWav
        ? "$p=New-Object Media.SoundPlayer '" + wav.replace(/'/g, "''") + "';$p.PlaySync()"
        : "[console]::beep(880,120)";
      cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    } else if (process.platform === "darwin") {
      cp.spawn("afplay", [haveWav ? wav : "/System/Library/Sounds/Ping.aiff"]);
    } else if (haveWav) {
      cp.spawn("aplay", ["-q", wav]);
    }
  } catch (_) { /* sound is optional */ }
}

// ---- poll + render ---------------------------------------------------------
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const res = await getAgents();
    const now = Date.now();
    if (!res.ok) {
      lastError = res.err;
      _agentCache = [];
      renderStatus([]);
      if (provider) provider.post([], errorText(res.err));
      return;
    }
    lastError = null;
    _agentCache = res.agents;

    // Recover idle sessions that actually await you (a typed question or an
    // approval request). Mutate before transition tracking so a busy->awaiting
    // change still fires the "needs you" alert.
    if (cfg().get("detectTypedQuestions") !== false) {
      for (const a of res.agents) {
        if (a.status !== "idle") continue;
        const reason = idleAwaitReason(a.sessionId);
        if (reason) { a.status = "waiting"; a.waitingFor = reason; }
      }
    }

    const curSids = new Set();
    for (const a of res.agents) {
      curSids.add(a.sessionId);
      if (prevStatus[a.sessionId] === "busy" && a.status === "idle") finishedAt[a.sessionId] = now;
    }

    const sessions = buildSessions(res.agents, now);
    renderStatus(sessions);
    if (provider) provider.post(sessions);
    try { D.publish(sessions); } catch (_) { /* device is additive */ }

    const doNotify = cfg().get("notifications");
    for (const a of res.agents) {
      const prev = prevStatus[a.sessionId];
      if (seeded && prev && prev !== a.status) {
        const s = sessions.find((x) => x.sid === a.sessionId);
        const label = (s && s.name) || a.name || "session";
        if (a.status === "waiting") {
          playSound();
          if (doNotify) vscode.window.showWarningMessage(`🔴 ${label} needs you`, "Jump to it")
            .then((x) => { if (x && s) jumpToTerminal(s); });
        } else if (a.status === "idle" && prev === "busy" && doNotify) {
          vscode.window.showInformationMessage(`🟢 ${label} finished`, "Jump to it")
            .then((x) => { if (x && s) jumpToTerminal(s); });
        }
      }
      prevStatus[a.sessionId] = a.status;
    }
    for (const sid of Object.keys(prevStatus)) {
      if (!curSids.has(sid)) { delete prevStatus[sid]; delete finishedAt[sid]; termNames.delete(sid); _tPath.delete(sid); }
    }
    seeded = true;

    resolveTermNames(sessions);
  } finally {
    polling = false;
  }
}

function errorText(err) {
  const bin = cfg().get("claudePath") || "claude";
  const msg = (err && err.message) || String(err);
  if (/not recognized|ENOENT|not found/i.test(msg)) {
    return `Couldn't run \`${bin} agents\`. Install the Claude Code CLI, or set \`overlord.claudePath\` to its full path.`;
  }
  return `\`${bin} agents --json\` failed: ${msg}`;
}

function renderStatus(sessions) {
  const n = sessions.filter((s) => s.state === "needs").length;
  const w = sessions.filter((s) => s.state === "working").length;
  const d = sessions.filter((s) => s.state === "done").length;
  statusItem.text = `$(eye) 🔴${n} 🟡${w} 🟢${d}`;
  statusItem.tooltip = lastError
    ? "Overlord — couldn't reach `claude agents`"
    : `Overlord — ${n} need you, ${w} working, ${d} just finished\nClick to open the board`;
  statusItem.backgroundColor = n > 0 ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  statusItem.show();
  if (provider && provider._view) {
    provider._view.badge = n > 0 ? { value: n, tooltip: `${n} session(s) need you` } : undefined;
  }
}

// ---- webview ---------------------------------------------------------------
class OverlordViewProvider {
  constructor() { this._view = null; }
  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === "jump") {
        const s = buildSessions(_agentCache, Date.now()).find((x) => x.sid === msg.sid);
        if (s) jumpToTerminal(s);
      }
    });
    setTimeout(() => refresh(), 40);
  }
  post(sessions, error) {
    if (this._view) this._view.webview.postMessage({ type: "sessions", sessions, error: error || null });
  }
  html() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;padding:6px 0;font-family:var(--vscode-font-family);color:var(--vscode-foreground)}
  .empty{padding:20px 16px;color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;line-height:1.6}
  .row{display:flex;align-items:center;gap:11px;padding:9px 10px;margin:3px 6px;border-radius:8px;
       background:var(--vscode-list-hoverBackground);border-left:3px solid #555;cursor:pointer;transition:transform .08s}
  .row:hover{background:var(--vscode-list-activeSelectionBackground);transform:translateX(1px)}
  .row.needs{animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 #ff5c6c55}50%{box-shadow:0 0 0 5px #ff5c6c00}}
  .eye{width:30px;height:30px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}
  .eye svg{width:30px;height:30px;display:block}
  .row.needs .eye{animation:blink 2.6s infinite}
  @keyframes blink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.15)}}
  .meta{min-width:0;flex:1}
  .nm{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .st{font-size:10.5px;margin-top:2px}
</style></head><body>
<div id="root"><div class="empty">Looking for Claude Code sessions…</div></div>
<script>
  const api = acquireVsCodeApi();
  function eye(color){
    return '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" fill="'+color+'" '
      + 'd="M2.5 12 C6 6.8 18 6.8 21.5 12 C18 17.2 6 17.2 2.5 12 Z '
      + 'M15.2 12 A3.2 3.2 0 1 1 8.8 12 A3.2 3.2 0 1 1 15.2 12 Z '
      + 'M13.4 12 A1.4 1.4 0 1 1 10.6 12 A1.4 1.4 0 1 1 13.4 12 Z"/></svg>';
  }
  function render(sessions, error){
    const root=document.getElementById("root"); root.innerHTML="";
    if(error){ const d=document.createElement("div"); d.className="empty"; d.textContent=error; root.appendChild(d); return; }
    if(!sessions.length){ root.innerHTML='<div class="empty">No active Claude Code sessions.<br>Start one in a terminal and it\\'ll appear here.</div>'; return; }
    for(const s of sessions){
      const row=document.createElement("div"); row.className="row "+s.state;
      const av=document.createElement("div"); av.className="eye"; av.innerHTML=eye(s.color);
      const meta=document.createElement("div"); meta.className="meta";
      const nm=document.createElement("div"); nm.className="nm"; nm.textContent=s.name;
      const st=document.createElement("div"); st.className="st"; st.style.color=s.color; st.textContent=s.sub;
      meta.appendChild(nm); meta.appendChild(st); row.appendChild(av); row.appendChild(meta);
      row.onclick=()=>api.postMessage({type:"jump",sid:s.sid});
      root.appendChild(row);
    }
  }
  window.addEventListener("message",e=>{ const m=e.data; if(m&&m.type==="sessions") render(m.sessions,m.error); });
</script></body></html>`;
  }
}

function activate(context) {
  provider = new OverlordViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("overlord.board", provider,
      { webviewOptions: { retainContextWhenHidden: true } }));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "overlord.board.focus";
  context.subscriptions.push(statusItem);

  if (cfg().get("device.enabled") !== false) {
    try {
      D.start({
        port: Math.max(1, cfg().get("device.port") || 7331),
        onJump: handleDeviceJump,
        log: (m) => console.log("[overlord] " + m),
      });
    } catch (e) { console.log("[overlord] device start failed: " + (e && e.message)); }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("overlord.refresh", () => refresh()),
    vscode.commands.registerCommand("overlord.toggleSound", async () => {
      const on = cfg().get("sound");
      await cfg().update("sound", !on, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage("Overlord sound " + (!on ? "ON 🔊" : "OFF 🔇"));
    }));

  refresh();
  const every = Math.max(1000, cfg().get("pollMs") || 2500);
  timer = setInterval(refresh, every);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() { if (timer) clearInterval(timer); try { D.stop(); } catch (_) {} }

module.exports = { activate, deactivate };
