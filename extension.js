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
const T = require("./transcript");
const { raiseVSCodeWindow } = require("./raise");

let provider;      // OverlordViewProvider
let statusItem;    // status-bar pill
let timer;         // poll interval
let polling = false;           // guard: never overlap slow polls
let seeded = false;            // suppress notifications on the first read
let prevStatus = {};           // sid -> last raw status (busy/waiting/idle)
let finishedAt = {};           // sid -> ms when it last went busy->idle
let statusSince = {};          // sid -> ms when it entered its current status
const panels = new Map();      // sid -> { panel, offset }  (open transcript viewers)
let lastError = null;          // last spawn error (for the empty state)
const PROC_TTL_MS = 15000;      // process parentage barely changes; scan rarely
let procCache = { at: 0, map: null, pending: null };
let termNames = new Map();      // sid -> resolved terminal tab name
let termPids = new Map();       // sid -> shell pid of its terminal (jump + "you are here")
let termResolveAt = 0;
let _agentCache = [];           // most recent raw records (for jump lookups)
let _metaCache = {};            // sid -> transcript meta, so off-poll reposts keep activity
let activeTermPid = 0;          // shell pid of the focused terminal ("you are here")

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

// Reverse of termPids: which session lives in the terminal with this shell pid?
function sidForTermPid(pid) {
  if (!pid) return null;
  for (const [sid, p] of termPids) if (p === pid) return sid;
  return null;
}

function buildSessions(agents, now, meta) {
  const doneFlashMs = (cfg().get("doneFlashSeconds") || 12) * 1000;
  if (!meta) meta = _metaCache;
  // The card for the terminal you're currently in gets a subtle "you are here"
  // accent. Driven by real terminal focus, never by clicking a card. Pure map
  // lookup — rendering must never touch the process tree.
  const hereSid = sidForTermPid(activeTermPid);
  return agents
    .map((a) => {
      const m = (meta && meta[a.sessionId]) || {};
      // startedAt arrives as epoch ms (number) from `claude agents --json`; older
      // builds sent an ISO string — accept both, else uptime is NaN and never shows.
      const started = typeof a.startedAt === "number" ? a.startedAt
                    : a.startedAt ? Date.parse(a.startedAt) : 0;
      const s = A.toSession(a, {
        finishedAtMs: finishedAt[a.sessionId], nowMs: now, doneFlashMs,
        termName: termNames.get(a.sessionId),
        statusSinceMs: statusSince[a.sessionId],
        startedAtMs: Number.isFinite(started) ? started : 0,
        model: m.model, ctxTokens: m.ctxTokens,
      });
      s.metaLine = A.metaLine(s);
      s.activity = m.activity || [];
      s.lastMsg = m.lastMsg || "";
      s.here = !!hereSid && s.sid === hereSid;
      return s;
    })
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

// One 64KB tail read per session per tick -> model, ctx tokens, activity, await reason.
function readMeta(sid) {
  try {
    const p = transcriptPath(sid);
    if (!p) return {};
    const fd = fs.openSync(p, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return T.readTail(buf.toString("utf8"), A.awaitReason);
    } finally { fs.closeSync(fd); }
  } catch (_) { return {}; }
}

// ---- transcript viewer (editor-area webview panel) -------------------------
function openTranscript(sid, name) {
  const existing = panels.get(sid);
  if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
  const panel = vscode.window.createWebviewPanel(
    "overlord.transcript", name || "session", vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = transcriptHtml();
  const entry = { panel, offset: 0 };
  panels.set(sid, entry);
  panel.onDidDispose(() => panels.delete(sid));

  const p = transcriptPath(sid);
  if (!p) { panel.webview.postMessage({ type: "full", html: '<div class="ov-note">Waiting for transcript…</div>' }); return; }
  try {
    const text = fs.readFileSync(p, "utf8");
    entry.offset = fs.statSync(p).size;
    let events = T.parse(text);
    let truncated = false;
    if (events.length > 500) { events = events.slice(-500); truncated = true; }
    panel.webview.postMessage({ type: "full", html: T.renderHtml(events, { truncatedNote: truncated }) });
  } catch (_) {
    panel.webview.postMessage({ type: "full", html: '<div class="ov-note">Waiting for transcript…</div>' });
  }
}

// On each poll tick, stream new transcript lines into any open panel.
function followPanels() {
  for (const [sid, entry] of panels) {
    const p = transcriptPath(sid);
    if (!p) continue;
    let size; try { size = fs.statSync(p).size; } catch (_) { continue; }
    if (size <= entry.offset) continue;
    try {
      const fd = fs.openSync(p, "r");
      try {
        const len = size - entry.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, entry.offset);
        const chunk = buf.toString("utf8");
        const nl = chunk.lastIndexOf("\n");
        if (nl < 0) continue;                       // no complete line yet; wait
        const complete = chunk.slice(0, nl + 1);
        entry.offset += Buffer.byteLength(complete, "utf8");
        const events = T.parse(complete);
        if (events.length) entry.panel.webview.postMessage({ type: "append", html: T.renderHtml(events) });
      } finally { fs.closeSync(fd); }
    } catch (_) { /* transient read race; retry next tick */ }
  }
}

function transcriptHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;padding:10px 14px;font-family:var(--vscode-editor-font-family,monospace);
       font-size:12px;line-height:1.5;color:var(--vscode-foreground)}
  .ov-note{color:var(--vscode-descriptionForeground);font-style:italic;margin:6px 0}
  .ov-text{margin:10px 0;white-space:pre-wrap;word-break:break-word}
  .ov-tool{font-weight:600;margin:14px 0 2px}
  .ov-diffsub{color:var(--vscode-descriptionForeground);margin:2px 0 4px}
  .ov-diff{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:4px;overflow:hidden}
  .ov-line{display:flex;white-space:pre}
  .ov-ln{width:46px;flex:0 0 auto;text-align:right;padding-right:10px;
         color:var(--vscode-editorLineNumber-foreground,#858585);user-select:none}
  .ov-code{flex:1;white-space:pre-wrap;word-break:break-word}
  .ov-line.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(60,200,120,.18));
               color:var(--vscode-gitDecoration-addedResourceForeground,#89d185)}
  .ov-line.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(220,80,90,.18));
               color:var(--vscode-gitDecoration-deletedResourceForeground,#f48771)}
  </style></head><body>
  <div id="root"></div>
  <script>
    const root=document.getElementById("root");
    function nearBottom(){ return window.innerHeight+window.scrollY >= document.body.scrollHeight-48; }
    window.addEventListener("message",(e)=>{
      const m=e.data; if(!m) return;
      if(m.type==="full"){ root.innerHTML=m.html; window.scrollTo(0,document.body.scrollHeight); }
      else if(m.type==="append"){ const b=nearBottom(); root.insertAdjacentHTML("beforeend",m.html);
        if(b) window.scrollTo(0,document.body.scrollHeight); }
    });
  </script></body></html>`;
}

// ---- new session launcher --------------------------------------------------
async function newSession() {
  const items = [];
  for (const wf of (vscode.workspace.workspaceFolders || [])) {
    items.push({ label: wf.name, description: wf.uri.fsPath, fsPath: wf.uri.fsPath });
    try {
      const projDir = path.join(wf.uri.fsPath, "projects");
      for (const d of fs.readdirSync(projDir, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith("."))
          items.push({ label: d.name, description: "projects/" + d.name, fsPath: path.join(projDir, d.name) });
      }
    } catch (_) { /* no projects/ dir -> just the root */ }
  }
  if (!items.length) { vscode.window.showInformationMessage("Overlord: open a folder first."); return; }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "New Claude Code session in…" });
  if (!pick) return;
  const cmd = cfg().get("newSessionCommand") || "claude";
  const term = vscode.window.createTerminal({ name: "claude — " + pick.label, cwd: pick.fsPath,
    location: vscode.TerminalLocation.Editor });
  term.show();
  term.sendText(cmd);
}

// ---- process tree (terminal labelling + jump) ------------------------------
// Scanning every process is expensive (~0.5-2s on Windows). It used to run
// synchronously, which froze the extension host — that's why a jump felt slow
// and why clicks landing during the freeze were swallowed. Now: async, never
// blocking; single-flight, so concurrent callers share one scan; and cached
// long enough that a jump almost never triggers one at all, because
// resolveTermNames keeps `termPids` warm on the poll.
function parseProcMap(out) {
  const map = new Map();
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

function scanProcMap() {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? new Map() : parseProcMap(out));
    if (process.platform === "win32") {
      cp.execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
        { encoding: "utf8", timeout: 6000, windowsHide: true, maxBuffer: 8 << 20 }, done);
    } else {
      cp.execFile("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 6000 }, done);
    }
  });
}

async function getProcMap() {
  if (procCache.map && Date.now() - procCache.at < PROC_TTL_MS) return procCache.map;
  if (procCache.pending) return procCache.pending;          // single-flight
  procCache.pending = scanProcMap().then((map) => {
    procCache = { at: Date.now(), map, pending: null };
    return map;
  });
  return procCache.pending;
}

// Given the open terminals, return the one whose shell pid is `pid`.
async function terminalByPid(terms, pid) {
  for (const t of terms) {
    let tpid; try { tpid = await t.processId; } catch (_) { tpid = undefined; }
    if (tpid && tpid === pid) return t;
  }
  return null;
}

const ancestorsOf = A.ancestorsOf;

// "You are here": remember which terminal has focus, then let buildSessions
// resolve it to a session on every render. We store the pid (stable) rather
// than the session id, so a card that appears later still picks up the accent.
// VS Code keeps reporting the last active terminal after you click into a file,
// so the marker persists instead of blinking off.
async function trackActiveTerminal(term) {
  let pid = 0;
  try { pid = (term && (await term.processId)) || 0; } catch (_) { pid = 0; }
  if (pid === activeTermPid) return;
  activeTermPid = pid;
  if (provider) provider.post(buildSessions(_agentCache, Date.now()));
  // Terminal we haven't mapped yet (focused before the first poll resolved it):
  // resolve it once, off the UI path, then repaint.
  if (pid && !sidForTermPid(pid)) {
    const sid = A.sessionForTerminal(_agentCache, pid, await getProcMap());
    if (sid && activeTermPid === pid) {
      termPids.set(sid, pid);
      if (provider) provider.post(buildSessions(_agentCache, Date.now()));
    }
  }
}

// Resolve each session to the VS Code terminal it runs in and remember the tab
// name, so sessions sharing a cwd stay distinguishable. Throttled.
async function resolveTermNames(sessions) {
  if (Date.now() - termResolveAt < 3000) return;
  termResolveAt = Date.now();
  const terms = vscode.window.terminals;
  if (!terms.length) return;
  const map = await getProcMap();
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
    if (!hit) continue;
    if (termNames.get(s.sid) !== hit.name) { termNames.set(s.sid, hit.name); changed = true; }
    // Cache the terminal pid too: jumps and the "you are here" accent then need
    // no process scan at all.
    if (termPids.get(s.sid) !== hit.pid) { termPids.set(s.sid, hit.pid); changed = true; }
  }
  if (changed && provider) provider.post(buildSessions(_agentCache, Date.now()));
}

async function jumpToTerminal(session) {
  const terms = vscode.window.terminals;
  if (!terms.length) {
    vscode.window.showInformationMessage("Overlord: no open terminals in this window.");
    return;
  }
  // Fast path: the poll already resolved this session's terminal.
  const known = termPids.get(session.sid);
  if (known) {
    const t = await terminalByPid(terms, known);
    if (t) { t.show(false); return; }
    termPids.delete(session.sid);   // terminal closed and was replaced
  }
  // Slow path: scan the process tree (async — never freezes the UI).
  if (session.pid) {
    const map = await getProcMap();
    if (map.size) {
      const anc = ancestorsOf(session.pid, map);
      for (const t of terms) {
        let tpid; try { tpid = await t.processId; } catch (_) { tpid = undefined; }
        if (tpid && anc.has(tpid)) { termPids.set(session.sid, tpid); t.show(false); return; }
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

    // One tail read per session -> feeds both "needs you" detection and the card
    // sub-line (model / ctx / activity), so we never read a transcript twice a tick.
    const meta = {};
    for (const a of res.agents) meta[a.sessionId] = readMeta(a.sessionId);
    _metaCache = meta;

    // Recover idle sessions that actually await you (a typed question or an
    // approval request). Mutate before transition tracking so a busy->awaiting
    // change still fires the "needs you" alert.
    if (cfg().get("detectTypedQuestions") !== false) {
      for (const a of res.agents) {
        if (a.status !== "idle") continue;
        const reason = meta[a.sessionId] && meta[a.sessionId].awaitReason;
        if (reason) { a.status = "waiting"; a.waitingFor = reason; }
      }
    }

    const curSids = new Set();
    for (const a of res.agents) {
      curSids.add(a.sessionId);
      if (prevStatus[a.sessionId] !== a.status) statusSince[a.sessionId] = now;
      if (prevStatus[a.sessionId] === "busy" && a.status === "idle") finishedAt[a.sessionId] = now;
    }

    const sessions = buildSessions(res.agents, now, meta);
    renderStatus(sessions);
    if (provider) provider.post(sessions);
    followPanels();
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
      if (!curSids.has(sid)) { delete prevStatus[sid]; delete finishedAt[sid]; delete statusSince[sid]; termNames.delete(sid); _tPath.delete(sid); }
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
      if (!msg) return;
      const find = (sid) => buildSessions(_agentCache, Date.now()).find((x) => x.sid === sid);
      if (msg.type === "jump") { const s = find(msg.sid); if (s) jumpToTerminal(s); }
      else if (msg.type === "open") { const s = find(msg.sid); openTranscript(msg.sid, s ? s.name : "session"); }
      else if (msg.type === "new") { newSession(); }
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
  /* "you are here": the session running in the focused terminal. Theme-native
     accent + tint, deliberately state-neutral so it never competes with the
     needs/working/done/idle colors. */
  .row.here{background:var(--vscode-list-inactiveSelectionBackground);
            box-shadow:inset 2px 0 0 0 var(--vscode-focusBorder)}
  .meta{min-width:0;flex:1}
  .nm{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .st{font-size:10.5px;margin-top:2px}
  .act{font-size:10px;margin-top:3px;color:var(--vscode-descriptionForeground);
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .msg{color:var(--vscode-foreground);opacity:.85}
  .chev{flex:0 0 auto;align-self:flex-start;margin-top:2px;font-size:10px;
        color:var(--vscode-descriptionForeground)}
  .jump{display:inline-block;margin-top:5px;margin-right:10px;font-size:10.5px;cursor:pointer;
        color:var(--vscode-textLink-foreground)}
  .jump:hover{text-decoration:underline}
  #hdr{padding:6px 10px}
  #new{width:100%;padding:7px;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;
       background:var(--vscode-statusBarItem-warningBackground,#c8860a);
       color:var(--vscode-statusBarItem-warningForeground,#000)}
  #new:hover{opacity:.88}
</style></head><body>
<div id="hdr"><button id="new">+ New YOLO session</button></div>
<div id="root"><div class="empty">Looking for Claude Code sessions…</div></div>
<script>
  const api = acquireVsCodeApi();
  document.getElementById("new").onclick=()=>api.postMessage({type:"new"});
  function eye(color){
    return '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" fill="'+color+'" '
      + 'd="M2.5 12 C6 6.8 18 6.8 21.5 12 C18 17.2 6 17.2 2.5 12 Z '
      + 'M15.2 12 A3.2 3.2 0 1 1 8.8 12 A3.2 3.2 0 1 1 15.2 12 Z '
      + 'M13.4 12 A1.4 1.4 0 1 1 10.6 12 A1.4 1.4 0 1 1 13.4 12 Z"/></svg>';
  }
  const expanded=new Set(); let last=null;   // sid -> card open; survives per-tick re-renders
  function render(sessions, error){
    last=[sessions,error];
    const root=document.getElementById("root"); root.innerHTML="";
    if(error){ const d=document.createElement("div"); d.className="empty"; d.textContent=error; root.appendChild(d); return; }
    if(!sessions.length){ root.innerHTML='<div class="empty">No active Claude Code sessions.<br>Start one in a terminal and it\\'ll appear here.</div>'; return; }
    for(const s of sessions){
      const row=document.createElement("div"); row.className="row "+s.state+(s.here?" here":"");
      const av=document.createElement("div"); av.className="eye"; av.innerHTML=eye(s.color);
      const meta=document.createElement("div"); meta.className="meta";
      const nm=document.createElement("div"); nm.className="nm"; nm.textContent=s.name;
      const st=document.createElement("div"); st.className="st"; st.style.color=s.color;
      st.textContent=s.metaLine||s.sub;
      meta.appendChild(nm); meta.appendChild(st);
      if(expanded.has(s.sid)){
        const icon=(a)=>a.startsWith("Bash:")?"🔧":a.startsWith("Edit:")||a.startsWith("Write:")?"✏️":
                        a.startsWith("Read:")?"📄":a.startsWith("thinking")?"💭":"•";
        for(const a of (s.activity||[])){
          const act=document.createElement("div"); act.className="act";
          act.textContent=icon(a)+" "+a; meta.appendChild(act);
        }
        if(s.lastMsg){
          const mg=document.createElement("div"); mg.className="act msg";
          mg.textContent="💬 "+s.lastMsg; meta.appendChild(mg);
        }
        const jump=document.createElement("span"); jump.className="jump";
        jump.textContent=(s.jumpLabel||"Open")+" ↗";
        jump.onclick=(ev)=>{ ev.stopPropagation(); api.postMessage({type:"jump",sid:s.sid}); };
        meta.appendChild(jump);
      }
      const chev=document.createElement("span"); chev.className="chev";
      chev.textContent=expanded.has(s.sid)?"▾":"▸";
      row.appendChild(av); row.appendChild(meta); row.appendChild(chev);
      row.onclick=()=>{ expanded.has(s.sid)?expanded.delete(s.sid):expanded.add(s.sid); if(last) render(last[0],last[1]); };
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

  // Always-available launcher in the status bar, so you can start a session
  // without opening the Overlord panel.
  const newSessionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  newSessionItem.text = "$(add) New YOLO Session";
  newSessionItem.tooltip = "Overlord: start a new Claude Code session";
  newSessionItem.command = "overlord.newSession";
  // Amber background so it stands out (VS Code only allows error/warning bg on
  // status-bar items; the panel's + New session button uses the same amber).
  newSessionItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  newSessionItem.show();
  context.subscriptions.push(newSessionItem);

  // Follow terminal focus, however it's reached: the card's jump link, a click
  // on the terminal tab itself, or Ctrl+` back into the last one.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((t) => { trackActiveTerminal(t); }));
  trackActiveTerminal(vscode.window.activeTerminal);

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
    vscode.commands.registerCommand("overlord.newSession", () => newSession()),
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
