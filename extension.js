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
const https = require("https");
const path = require("path");
const fs = require("fs");
const os = require("os");
const A = require("./agents");
const D = require("./device");
const T = require("./transcript");
const { raiseVSCodeWindow } = require("./raise");
const fsp = fs.promises;

let provider;      // OverlordViewProvider
let statusItem;    // status-bar pill
let timer;         // poll interval
let polling = false;           // guard: never overlap slow polls
let seeded = false;            // suppress notifications on the first read
let prevStatus = {};           // sid -> last raw status (busy/waiting/idle)
let finishedAt = {};           // sid -> ms when it last went busy->idle
const panels = new Map();      // sid -> { panel, offset }  (open transcript viewers)
let lastError = null;          // last spawn error (for the empty state)
const PROC_TTL_MS = 15000;     // process parentage barely changes; scan rarely
let procCache = { at: 0, map: null, pending: null };
let termNames = new Map();     // sid -> resolved terminal tab name
let termPids = new Map();      // sid -> shell pid of its terminal (jump + "you are here")
let termResolveAt = 0;
let _agentCache = [];          // most recent raw records (for jump lookups)
let activeTermPid = 0;         // shell pid of the focused terminal ("you are here")
const _termMiss = new Map();   // sid -> consecutive resolve passes with no terminal (background detection)
// Sessions the user has already looked at while they "need you": we grey the card
// and stop its blink, but keep the "needs you …" text so it stays on the radar.
// Cleared automatically the moment a session leaves the waiting state (see refresh),
// so a genuinely new ask re-blinks. In-memory only: a window reload starts fresh.
const _acked = new Set();       // sid -> user has seen this waiting session
function ackSession(sid) {
  if (!sid || _acked.has(sid)) return;
  _acked.add(sid);
  if (provider && _agentCache.length) attachAndPost(_agentCache, Date.now());  // grey it out immediately
}
// F1 — resilient polling: keep the last good board through transient spawn
// failures (the CLI vanishes from disk briefly during its own self-update).
let pollFails = 0;             // consecutive getAgents failures
let _lastGood = null;          // last successfully posted sessions array

// ---- card detail level (compact / full / remember) — contributed by DS ------
const _level = new Map();   // sid -> 0|1   (authoritative)
let _memento = null;        // context.globalState (null in harness mocks)
const LEVELS_KEY = "overlord.levels";   // persisted sid -> level map for the "remember" mode
function levelOf(sid) {
  if (!_level.has(sid)) {
    const mode = cfg().get("defaultDetail") || "full";
    let lvl = mode === "compact" ? 0 : 1;   // two modes only: 0 = condensed, 1 = expanded feed
    if (mode === "remember" && _memento) {
      const saved = _memento.get(LEVELS_KEY, {});
      if (typeof saved[sid] === "number") lvl = saved[sid] % 2;
    }
    _level.set(sid, lvl);
  }
  return _level.get(sid);
}
// Persist a cycled level (remember mode only). Fire-and-forget; globalState survives
// window reloads - which is also when sessions themselves survive (pty reconnect).
// Never pruned on session disappearance (a transient polling flicker must not erase
// remembered state); instead the map is size-capped, evicting the oldest entries
// (string-key insertion order).
const LEVELS_CAP = 100;
function rememberLevel(sid, lvl) {
  if (!_memento || (cfg().get("defaultDetail") || "full") !== "remember") return;
  try {
    const saved = Object.assign({}, _memento.get(LEVELS_KEY, {}));
    delete saved[sid];   // re-insert at the end so recently-touched sids evict last
    saved[sid] = lvl;
    const keys = Object.keys(saved);
    for (let i = 0; i < keys.length - LEVELS_CAP; i++) delete saved[keys[i]];
    _memento.update(LEVELS_KEY, saved);
  } catch (_) { /* persistence is best-effort */ }
}
function feedCap() {
  const n = Number(cfg().get("feedEvents") || 6);
  return Math.max(1, Math.min(20, Math.floor(n)));
}

// ---- terminal tab names: persist + restore across window reloads ------------
// A tab's custom name lives only in the window's memory; a reload rebuilds every
// tab from the surviving shell process with a default name ("powershell"). We
// remember sid -> name in globalState and re-apply after reload. VS Code has no
// rename-by-handle API — only a command acting on the ACTIVE terminal — so the
// restore pass briefly focuses each terminal it renames, once per window.
const TERMNAMES_KEY = "overlord.termNames";
const GENERIC_TERM = /^(powershell|pwsh|cmd|command prompt|bash|git bash|zsh|sh|fish|wsl|ubuntu[^,]*|terminal( \d+)?|node|claude)$/i;
let _restoredNames = false;
function saveTermName(sid, name) {
  if (!_memento || !name || GENERIC_TERM.test(name)) return;
  try {
    const m = Object.assign({}, _memento.get(TERMNAMES_KEY, {}));
    delete m[sid];                       // re-insert last so oldest evict first
    m[sid] = name;
    const keys = Object.keys(m);
    for (let i = 0; i < keys.length - 100; i++) delete m[keys[i]];
    _memento.update(TERMNAMES_KEY, m);
  } catch (_) { /* best-effort */ }
}
async function restoreTermNames() {
  if (_restoredNames || !_memento) return;
  const saved = _memento.get(TERMNAMES_KEY, {});
  if (!Object.keys(saved).length) { _restoredNames = true; return; }
  const terms = vscode.window.terminals;
  if (!terms.length || !_agentCache.length) return;   // retry next poll
  const map = await getProcMap();
  if (!map.size) return;
  const targets = [];
  for (const a of _agentCache) {
    const want = saved[a.sessionId];
    if (!want || !a.pid) continue;
    const anc = A.ancestorsOf(a.pid, map);
    for (const t of terms) {
      let tp; try { tp = await t.processId; } catch (_) { tp = undefined; }
      if (!tp || !anc.has(tp)) continue;
      // only fix tabs that regressed to a default shell name; never fight a
      // name the user typed after the reload
      if (t.name !== want && GENERIC_TERM.test(t.name)) targets.push({ t, want, sid: a.sessionId });
      break;
    }
  }
  _restoredNames = true;                 // one pass per window, hit or miss
  if (!targets.length) return;
  const prevActive = vscode.window.activeTerminal;
  for (const { t, want, sid } of targets) {
    try {
      t.show(false);                     // rename command acts on the active terminal
      await new Promise((r) => setTimeout(r, 150));
      await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: want });
      termNames.set(sid, want);
    } catch (_) { /* best-effort per terminal */ }
  }
  try {
    if (prevActive) prevActive.show(false);
    else await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  } catch (_) { /* focus restore is cosmetic */ }
}

function cfg() { return vscode.workspace.getConfiguration("overlord"); }

// ---- launch pills — contributed by DS ---------------------------------------
let _extensionPath = null;   // set in activate; needed for the terminal tab icon
function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p && p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
// Normalized launcher list from the flat launcherN.* settings (each field is a
// primitive so the Settings UI renders real inputs, not an "Edit in settings.json"
// link). Slot N is active iff its command is a non-empty string. Tolerates any
// config shape (harness mocks return undefined -> []).
function getLaunchers() {
  const c = cfg();
  const out = [];
  for (let i = 1; i <= 3; i++) {
    const cmd = c.get("launcher" + i + ".command");
    if (typeof cmd !== "string" || !cmd.trim()) continue;
    const name = c.get("launcher" + i + ".name");
    const icon = c.get("launcher" + i + ".icon");
    const cwd = c.get("launcher" + i + ".cwd");
    out.push({
      command: cmd.trim(),
      name: (typeof name === "string" && name.trim()) || cmd.trim(),
      icon: (typeof icon === "string" && icon.trim()) || "claude",
      cwd: (typeof cwd === "string" && cwd.trim()) ? expandTilde(cwd.trim()) : "",
      autoLaunch: c.get("launcher" + i + ".autoLaunch") === true,
    });
  }
  return out;
}
function launchersForWebview() {
  return getLaunchers().map((l) => ({ icon: l.icon, name: l.name, command: l.command, cwd: l.cwd, autoLaunch: l.autoLaunch }));
}
function launchLauncher(l) {
  try {
    const term = vscode.window.createTerminal({
      name: l.name,
      cwd: l.cwd || os.homedir(),
      location: vscode.TerminalLocation.Editor,   // editor-area tab
      iconPath: _extensionPath ? vscode.Uri.file(path.join(_extensionPath, "media", "claude-icon.svg")) : undefined,
      // Transient ONLY for auto-launch pills (restore + autoLaunch would duplicate).
      // A manually launched pill is a working session; killing its tab on reload
      // orphaned a live session on 2026-07-12. Manual pills must survive reloads.
      isTransient: l.autoLaunch === true,
    });
    term.show();
    // Typed into the user's default shell profile — cross-platform (the fork
    // hardcoded /bin/zsh, which breaks everywhere but macOS).
    term.sendText(l.command);
  } catch (e) {
    try { vscode.window.showWarningMessage("Overlord: launch failed - " + ((e && e.message) || String(e))); } catch (_) {}
  }
}

// ---- data: `claude agents --json` ------------------------------------------
function getAgents() {
  return new Promise((resolve) => {
    const bin = cfg().get("claudePath") || "claude";
    // cp.exec (shell) on purpose: on Windows the CLI is a .cmd shim, which
    // execFile cannot spawn directly.
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

function buildSessions(agents, now) {
  const doneFlashMs = (cfg().get("doneFlashSeconds") || 12) * 1000;
  return agents
    .map((a) => A.toSession(a, {
      finishedAtMs: finishedAt[a.sessionId], nowMs: now, doneFlashMs,
      termName: termNames.get(a.sessionId),
    }))
    .sort((x, y) => (A.ORDER[x.state] - A.ORDER[y.state]) || x.name.localeCompare(y.name));
}

// ---- transcript tails --------------------------------------------------------
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

const READ_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024];   // firm 1 MB cap
const _tailCache = new Map();   // sid -> { size, mtimeMs, lines }

// One-time larger read used to SEED backgrounded-agent tracking the first time we
// see a session (fresh start or window reload). A still-running agent's launch may
// sit far above the 64KB poll window, so on first sight we scan a big tail once to
// find agents already in flight; the per-poll 64KB window + mergeTelemetry take
// over after that. Capped so a pathological multi-MB transcript can't stall startup.
const SEED_READ = 4 * 1024 * 1024;
async function readSeedLines(sid) {
  const p = transcriptPath(sid);
  if (!p) return null;
  let stat; try { stat = await fsp.stat(p); } catch (_) { return null; }
  const len = Math.min(SEED_READ, stat.size);
  const start = stat.size - len;
  let fh;
  try {
    fh = await fsp.open(p, "r");
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return A.splitTail(buf.toString("utf8"), start > 0);
  } catch (_) { return null; }
  finally { if (fh) { try { await fh.close(); } catch (_) {} } }
}

async function readTailLines(sid) {
  const p = transcriptPath(sid);
  if (!p) return null;
  let stat;
  try { stat = await fsp.stat(p); } catch (_) { return null; }
  const cached = _tailCache.get(sid);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.lines;

  let lines = [];
  let fh;
  try {
    fh = await fsp.open(p, "r");
    for (const step of READ_STEPS) {
      const len = Math.min(step, stat.size);
      const start = stat.size - len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      lines = A.splitTail(buf.toString("utf8"), start > 0);
      // enough if we have some assistant content or we've read the whole file
      if (start === 0 || lines.length >= 24) break;
    }
  } catch (_) {
    return cached ? cached.lines : null;
  } finally {
    if (fh) { try { await fh.close(); } catch (_) {} }
  }
  // Pathological: a single line larger than the whole 1 MB window leaves splitTail
  // with nothing (the sole segment is a discarded fragment). Keep the "never blanks"
  // guarantee: hand recentEvents one non-blank unparseable line so it emits its placeholder.
  if (lines.length === 0 && stat.size > 0) lines = ["__overlord_oversized_line__"];
  _tailCache.set(sid, { size: stat.size, mtimeMs: stat.mtimeMs, lines });
  return lines;
}

// Why an idle session actually needs you ("typed a question" / "awaiting your
// reply"), or null if it is genuinely done. Approval-style closers ("ready when
// you are", "let me know which...") count, not just trailing question marks.
function idleAwaitReason(lines) {
  try {
    if (!lines) return null;
    return A.awaitReason(A.lastAssistantTextFromLines(lines));
  } catch (_) { return null; }
}

// Read each session's transcript tail once per poll and derive everything
// transcript-based: feed events (expanded rows), needs-you recovery (idle rows
// and stale busy rows), and telemetry (all rows — reads are mtime-cached so
// unchanged files cost nothing). Always overwrites _lastTranscriptData so
// non-poll post paths (resolveTermNames, cycleLevel, focus changes) can attach
// current data safely.
let _lastTranscriptData = { feeds: new Map(), telemetry: new Map() };
const _prevTele = new Map();   // sid -> last merged telemetry (sticky lastUserTs across window slides)
async function computeTranscriptData(agents, nowMs) {
  const detect = cfg().get("detectTypedQuestions") !== false;
  const cap = feedCap();
  const now = nowMs || Date.now();
  const feeds = new Map();       // sid -> feed[]
  const telemetry = new Map();   // sid -> telemetryFromLines output
  await Promise.all(agents.map(async (a) => {
    const sid = a.sessionId;
    const lines = await readTailLines(sid);
    if (!lines) return;
    let prev = _prevTele.get(sid);
    if (prev === undefined) {
      // First sight (fresh start or window reload): seed the pending-agent set from
      // a larger read, since a still-running backgrounded agent's launch may be far
      // above the 64KB poll window and would otherwise never be counted.
      const seedLines = await readSeedLines(sid);
      const seed = seedLines ? A.telemetryFromLines(seedLines) : null;
      if (seed) {
        const done = new Set(seed.agentDoneIds);
        const pending = {};
        for (const l of seed.agentLaunches) if (!done.has(l.id)) pending[l.id] = l.desc || "";
        prev = { lastUserTs: null, pendingAgents: pending };
      }
    }
    const merged = A.mergeTelemetry(prev, A.telemetryFromLines(lines));
    _prevTele.set(sid, merged);
    telemetry.set(sid, merged);
    if (detect && a.status === "idle") {
      const reason = idleAwaitReason(lines);
      if (reason) { a.status = "waiting"; a.waitingFor = reason; }
    } else if (detect && a.status === "busy") {
      // F2 — `busy` can mean "a background shell never exited" while the turn
      // actually ended on a question (a session sat "working 13h56m" on a
      // 14h-old ask). Stale transcript + awaiting last message -> needs you.
      const ent = _tailCache.get(sid);
      const reason = A.busyAwaitReason(
        A.lastAssistantTextFromLines(lines), ent ? ent.mtimeMs : null, now);
      if (reason) { a.status = "waiting"; a.waitingFor = reason + " · bg task running"; }
    }
    feeds.set(sid, A.recentEvents(lines, cap));   // board shows it only when expanded
  }));
  _lastTranscriptData = { feeds, telemetry };
  return _lastTranscriptData;
}

// Build display sessions, attach level+feed+telemetry strings + the "you are
// here" flag, render the status bar, and post to the webview (and the optional
// hardware screen). The header stays uniform (name); the status line carries
// state + elapsed + model + subagents, host-formatted.
// Board order: unseen "needs you" blinks at the top; working and the brief green
// "just finished" flash next; a seen-but-still-waiting card sinks below them but
// stays above plain idle so it's still on the radar; idle at the bottom. Responding
// (idle/needs -> busy) or a fresh ask (ack cleared on leaving waiting) pops it back up.
function sortRank(s) {
  if (s.state === "needs") return s.acked ? 3 : 0;   // unseen top; seen demoted below done
  if (s.state === "working") return 1;
  if (s.state === "done") return 2;                  // just-finished green flash
  return 4;                                          // idle
}
function attachAndPost(agents, now, tdata) {
  const d = tdata || _lastTranscriptData;
  const hereSid = sidForTermPid(activeTermPid);
  const sessions = buildSessions(agents, now);
  for (const s of sessions) {
    s.level = levelOf(s.sid);
    s.feed = d.feeds.get(s.sid) || [];
    s.here = !!hereSid && s.sid === hereSid;
    s.bg = (_termMiss.get(s.sid) || 0) >= 2;   // headless: no terminal hosts it
    s.acked = s.state === "needs" && _acked.has(s.sid);   // seen-but-still-waiting -> grey, no blink
    const tt = A.telemetryText(s, d.telemetry.get(s.sid) || null, now);
    s.sub = tt.statusText;          // .st renders sub verbatim - statusText replaces it
    s.metaText = s.bg ? ["background", tt.metaText].filter(Boolean).join(" · ") : tt.metaText;
    s.tooltipLines = tt.tooltipLines;
    // the satellite screen renders one line per session
    s.metaLine = tt.metaText ? tt.statusText + " · " + tt.metaText : tt.statusText;
  }
  // Re-sort now that `acked` is known (buildSessions can't see it): a seen-but-
  // still-waiting card drops below working and just-finished, above idle. Order:
  // blinking needs -> working -> just finished -> seen/acked needs -> idle.
  sessions.sort((x, y) => (sortRank(x) - sortRank(y)) || x.name.localeCompare(y.name));
  renderStatus(sessions);
  if (provider) provider.post(sessions);
  try { D.publish(sessions); } catch (_) { /* device is additive */ }
  _lastGood = sessions;
  return sessions;
}

// ---- transcript viewer (editor-area webview panel) -------------------------
function openTranscript(sid, name) {
  ackSession(sid);   // opening the transcript = I've seen it
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

// ---- new session launcher (folder picker; the pills are the one-click path) --
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

// "You are here": remember which terminal has focus; attachAndPost resolves it
// to a session on every render. We store the pid (stable) rather than the
// session id, so a card that appears later still picks up the accent. VS Code
// keeps reporting the last active terminal after you click into a file, so the
// marker persists instead of blinking off.
async function trackActiveTerminal(term) {
  let pid = 0;
  try { pid = (term && (await term.processId)) || 0; } catch (_) { pid = 0; }
  if (pid === activeTermPid) return;
  activeTermPid = pid;
  // Focusing a session's terminal (clicking its tab, Ctrl+`, or a jump) counts as
  // "I've seen it": ack it so a needs-you card stops blinking and greys out.
  const known = sidForTermPid(pid);
  if (known) ackSession(known);
  if (provider && _agentCache.length) attachAndPost(_agentCache, Date.now());
  // Terminal we haven't mapped yet (focused before the first poll resolved it):
  // resolve it once, off the UI path, then repaint.
  if (pid && !known) {
    const sid = A.sessionForTerminal(_agentCache, pid, await getProcMap());
    if (sid && activeTermPid === pid) {
      termPids.set(sid, pid);
      ackSession(sid);
      if (provider && _agentCache.length) attachAndPost(_agentCache, Date.now());
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
    if (!hit) {
      // No terminal hosts this session (spawned headless by another session or
      // a script). Two consecutive confirmed misses -> label it "background".
      const miss = (_termMiss.get(s.sid) || 0) + 1;
      _termMiss.set(s.sid, miss);
      if (miss === 2) changed = true;
      continue;
    }
    if (_termMiss.delete(s.sid)) changed = true;
    if (termNames.get(s.sid) !== hit.name) { termNames.set(s.sid, hit.name); changed = true; }
    saveTermName(s.sid, hit.name);       // survives window reloads (globalState)
    // Cache the terminal pid too: jumps and the "you are here" accent then need
    // no process scan at all.
    if (termPids.get(s.sid) !== hit.pid) { termPids.set(s.sid, hit.pid); changed = true; }
  }
  if (changed && provider) attachAndPost(_agentCache, Date.now());
}

// NOTE: no raiseVSCodeWindow() here. An in-panel jump means VS Code already
// has focus, and on Windows the raise (SW_RESTORE) un-maximizes an already-
// maximized window. Only the hardware-screen tap path raises (handleDeviceJump).
async function jumpToTerminal(session) {
  ackSession(session.sid);   // opening a session = I've seen it
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

// ---- Claude usage (opt-in) -------------------------------------------------
// Off by default. When on, reads the local Claude OAuth token and does one plain
// GET of /api/oauth/usage (a usage read — 0 tokens, no inference) to show the same
// session/weekly/per-model limits as the Claude settings panel. Nothing leaves the
// machine except that request to Anthropic's own API. Polled on its own slow timer.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_POLL_MS = 60000;              // healthy cadence
// Delay before each successive attempt while a fetch keeps failing. Back off 2m→5m→10m,
// then drop back to 60s and probe 3 times; if those also fail, re-enter the ladder. Cycles.
const USAGE_FAIL_SCHEDULE_MS = [120000, 300000, 600000, 60000, 60000, 60000];
let _usage = null;        // last GOOD display model ({plan,rows}); kept across transient errors
let _usageFetchTimer = null;  // setTimeout for the next fetch (dynamic delay)
let _usageTickTimer = null;   // 30s cosmetic re-post so "updated Nm ago" / "retrying in Nm" stay fresh
let _usageBackoff = 0;        // index into USAGE_BACKOFF_MS; cycles on repeated 429
let _usageFetchedAt = 0;      // epoch ms of the last successful (200) fetch
let _usageNextAt = 0;         // epoch ms the next fetch is scheduled for (for "retrying in Nm")
let _usageState = "idle";     // idle | loading | checking | ok | ratelimited | login | nologin
// Live on/off flag. The enable/disable buttons set this DIRECTLY (synchronously),
// so the card reacts instantly and never depends on config-read timing after an
// update. `overlord.usage` is still the persisted source of truth: we sync from it
// on activate and on external settings changes.
let _usageOn = false;

let _extVersion = "0"; try { _extVersion = require("./package.json").version || "0"; } catch (_) {}
function usageEnabled() { return cfg().get("usage") === true; }
// "Not now" only silences the invite for the CURRENT version: we store the version
// it was dismissed at, so a later update re-offers it once. (An older boolean value
// from before this change never matches the version string, so it re-offers too.)
function usageDismissed() { return !!(_memento && _memento.get("overlord.usageDismissed") === _extVersion); }

// Read only the fields we need from the credentials file; never logged/echoed.
function readClaudeCreds() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")).claudeAiOauth || {};
    return { token: o.accessToken, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier };
  } catch (_) { return {}; }
}
function httpsGetJson(url, headers) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, { headers, timeout: 8000 }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; if (body.length > (1 << 20)) req.destroy(); });
        res.on("end", () => { let json = null; try { json = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json, headers: res.headers || {} }); });
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null, headers: {} }); });
      req.on("error", () => resolve({ status: 0, json: null, headers: {} }));
    } catch (_) { resolve({ status: 0, json: null, headers: {} }); }
  });
}
// Schedule the next fetch `ms` from now (single dynamic timer, replaces any pending one).
function scheduleNextUsage(ms) {
  if (_usageFetchTimer) { clearTimeout(_usageFetchTimer); _usageFetchTimer = null; }
  if (!_usageOn) return;
  _usageNextAt = Date.now() + ms;
  _usageFetchTimer = setTimeout(() => { fetchUsage().catch(() => {}); }, ms);
}
// Pick the delay after a transient failure, walking USAGE_FAIL_SCHEDULE_MS and cycling.
// A real Retry-After (seconds > 0) overrides the delay but the streak still advances.
function nextUsageBackoff(headers) {
  const d = USAGE_FAIL_SCHEDULE_MS[_usageBackoff % USAGE_FAIL_SCHEDULE_MS.length];
  _usageBackoff = (_usageBackoff + 1) % USAGE_FAIL_SCHEDULE_MS.length;
  const ra = parseInt((headers && headers["retry-after"]) || "", 10);
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  return d;
}
async function fetchUsage() {
  if (!_usageOn) { _usage = null; return; }
  const c = readClaudeCreds();
  if (!c.token) { _usageState = "nologin"; postUsage(); scheduleNextUsage(USAGE_POLL_MS); return; }
  _usageState = _usage ? "checking" : "loading";   // brief feedback; keeps last-good rows visible
  postUsage();
  const r = await httpsGetJson(USAGE_URL, {
    "Authorization": "Bearer " + c.token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "overlord-vscode",
  });
  if (r.status === 200 && r.json) {
    const u = A.parseUsage(r.json, { subscriptionType: c.subscriptionType, rateLimitTier: c.rateLimitTier });
    const now = Date.now();
    for (const row of u.rows) row.resetText = A.fmtUsageReset(row.resetsAt, now);
    _usage = u;                       // new good snapshot
    _usageFetchedAt = now;
    _usageState = "ok";
    _usageBackoff = 0;                 // healthy again — reset the ladder
    scheduleNextUsage(USAGE_POLL_MS);
  } else if (r.status === 401) {
    _usageState = "login";            // token invalid — last-good (if any) is shown greyed with this note
    scheduleNextUsage(USAGE_POLL_MS);
  } else {
    _usageState = "ratelimited";      // 429 / timeout / 5xx: keep last-good, back off
    scheduleNextUsage(nextUsageBackoff(r.headers));
  }
  postUsage();
}
function postUsage() { if (provider && provider.postUsage) provider.postUsage(); }
function startUsageTimer() {
  if (_usageFetchTimer) { clearTimeout(_usageFetchTimer); _usageFetchTimer = null; }
  if (_usageTickTimer) { clearInterval(_usageTickTimer); _usageTickTimer = null; }
  if (!_usageOn) { _usage = null; _usageState = "idle"; postUsage(); return; }
  _usageBackoff = 0;
  postUsage();          // instant feedback: render the card frame ("Loading…") now
  fetchUsage();         // fills in the numbers a moment later (and schedules the next fetch)
  // Cosmetic-only: re-post every 30s so "updated Nm ago" / "retrying in Nm" stay current
  // between fetches (a backoff can leave up to 10 minutes between real fetches).
  _usageTickTimer = setInterval(() => { if (_usageOn) postUsage(); }, 30000);
}

// ---- poll + render ---------------------------------------------------------
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const res = await getAgents();
    const now = Date.now();
    if (!res.ok) {
      // F1: tolerate transient failures (~2 polls). The CLI self-update window
      // and spawn hiccups under load are normal, not outages.
      pollFails++;
      lastError = res.err;
      const action = A.pollFailureAction(pollFails, !!_lastGood);
      if (action === "repost") { if (provider) provider.post(_lastGood, null, "reconnecting…"); return; }
      if (action === "wait") return;   // cold start: leave the placeholder alone
      // Hard failure (3+ in a row). Even now, a last-good board beats a blank
      // panel: sessions stay visible with the error as a note. Only a session
      // list we never had justifies the bare error state.
      if (_lastGood) { if (provider) provider.post(_lastGood, null, errorText(res.err)); return; }
      _agentCache = [];
      renderStatus([]);
      if (provider) provider.post([], errorText(res.err));
      return;
    }
    pollFails = 0;
    lastError = null;
    _agentCache = res.agents;

    // One tail read per session -> feed events, telemetry, and needs-you
    // recovery (idle questions + stale busy sessions). Mutates a.status before
    // transition tracking so the change still fires the "needs you" alert.
    const tdata = await computeTranscriptData(res.agents, now);

    const curSids = new Set();
    for (const a of res.agents) {
      curSids.add(a.sessionId);
      if (prevStatus[a.sessionId] === "busy" && a.status === "idle") finishedAt[a.sessionId] = now;
    }

    const sessions = attachAndPost(res.agents, now, tdata);
    followPanels();

    for (const a of res.agents) {
      const prev = prevStatus[a.sessionId];
      // Alert only via sound now — the left-panel cards are the visual channel.
      // (The old bottom-right toasts were removed by request.)
      if (seeded && prev && prev !== a.status && a.status === "waiting") playSound();
      // A session that is no longer waiting starts a fresh episode: drop any prior
      // ack so the NEXT "needs you" blinks again instead of appearing pre-greyed.
      if (a.status !== "waiting") _acked.delete(a.sessionId);
      prevStatus[a.sessionId] = a.status;
    }
    for (const sid of Object.keys(prevStatus)) {
      if (!curSids.has(sid)) {
        delete prevStatus[sid]; delete finishedAt[sid];
        termNames.delete(sid); termPids.delete(sid); _termMiss.delete(sid); _tPath.delete(sid);
        _tailCache.delete(sid); _level.delete(sid); _prevTele.delete(sid); _acked.delete(sid);
      }
    }
    seeded = true;

    resolveTermNames(sessions);
    if (!_restoredNames) restoreTermNames().catch(() => {});
  } catch (e) {
    // Never fail silently: surface the error to the panel instead of leaving it
    // stuck on the placeholder. Also prevents an unhandled rejection.
    try { if (provider) provider.post([], "Overlord: refresh failed - " + (e && e.message ? e.message : String(e))); } catch (_) {}
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
    // Per-resolve flag (not provider-global): a stale watchdog timer from a previous
    // resolve must never read a newer view's state. Register the message handler
    // BEFORE assigning html so the webview's immediate {type:"ready"} can't be missed.
    let ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };   // html is fully inline; sound plays host-side
    view.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      if (msg.type === "ready") {
        ready = true;
        this.postUsage();
      } else if (msg.type === "usageEnable") {
        _usageOn = true;                 // flip the live flag first — instant, no config-read race
        startUsageTimer();
        try { await cfg().update("usage", true, vscode.ConfigurationTarget.Global); } catch (_) {}   // persist for next reload
      } else if (msg.type === "usageDisable") {
        _usageOn = false;
        startUsageTimer();
        try { await cfg().update("usage", false, vscode.ConfigurationTarget.Global); } catch (_) {}
      } else if (msg.type === "usageDismiss") {
        if (_memento) await _memento.update("overlord.usageDismissed", _extVersion);
        this.postUsage();
      } else if (msg.type === "usageRefresh") {
        _usageBackoff = 0;   // manual refresh: drop any backoff and check now
        fetchUsage();
      } else if (msg.type === "jump") {
        const s = buildSessions(_agentCache, Date.now()).find((x) => x.sid === msg.sid);
        if (!s) return;
        // A background (headless) session has no terminal tab; a jump would dead-end
        // on a sibling terminal that shares its cwd. Open its transcript instead —
        // the only way to actually see a headless session's state.
        if ((_termMiss.get(s.sid) || 0) >= 2) openTranscript(s.sid, s.name);
        else jumpToTerminal(s);
      } else if (msg.type === "open") {
        const s = buildSessions(_agentCache, Date.now()).find((x) => x.sid === msg.sid);
        openTranscript(msg.sid, s ? s.name : "session");
      } else if (msg.type === "new") {
        newSession();
      } else if (msg.type === "cycleLevel" && msg.sid) {
        const lvl = (levelOf(msg.sid) + 1) % 2;
        _level.set(msg.sid, lvl);
        rememberLevel(msg.sid, lvl);
        if (_agentCache && _agentCache.length) {
          const tdata = await computeTranscriptData(_agentCache, Date.now());
          attachAndPost(_agentCache, Date.now(), tdata);   // immediate; independent of the poll cycle
        }
      } else if (msg.type === "launch") {
        // Index-only inbound: the webview can never choose the command string; host
        // re-reads live config so a stale webview can only trigger a currently-configured launcher.
        if (Number.isInteger(msg.index)) {
          const ls = getLaunchers();
          if (msg.index >= 0 && msg.index < ls.length) launchLauncher(ls[msg.index]);
        }
      } else if (msg.type === "openSettings") {
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:jana81000.overlord-vscode launcher");
      }
    });
    view.webview.html = this.html();
    setTimeout(() => refresh(), 40);
    // The webview posts {type:"ready"} as its first act. If it never arrives, the UI script
    // never ran at all (a syntax error in the cooked script, or VS Code blocking the webview).
    // The webview can't report its own death, so say it in a native notification, which
    // renders outside the webview.
    setTimeout(() => {
      if (ready) return;
      vscode.window.showWarningMessage(
        "Overlord: the sessions panel UI never loaded (its script never ran). " +
        "The status-bar counter still works. Check the webview DevTools console " +
        "('Developer: Open Webview Developer Tools') and try 'Developer: Reload Window'.");
    }, 6000);
  }
  post(sessions, error, note) {
    if (this._view) this._view.webview.postMessage({ type: "sessions", sessions, error: error || null, note: note || null, launchers: launchersForWebview() });
  }
  postUsage() {
    const meta = { state: _usageState, fetchedAt: _usageFetchedAt, nextAt: _usageNextAt };
    if (this._view) this._view.webview.postMessage({ type: "usage", usage: _usage, enabled: _usageOn, dismissed: usageDismissed(), meta });
  }
  html() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{margin:0;padding:6px 0;font-family:var(--vscode-font-family);color:var(--vscode-foreground)}
  .empty{padding:20px 16px;color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;line-height:1.6}
  .row{display:flex;align-items:center;gap:11px;padding:9px 10px;margin:3px 6px;border-radius:8px;
       background:var(--vscode-list-hoverBackground);border-left:3px solid #555;cursor:pointer;transition:transform .08s}
  .row:hover{background:var(--vscode-list-activeSelectionBackground);transform:translateX(1px)}
  .row.needs{animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 #ff5c6c55}50%{box-shadow:0 0 0 5px #ff5c6c00}}
  /* Acknowledged: user has already looked at this waiting session. Stop the pulse
     and the eye-blink and mute it to grey, but keep the "needs you …" text so it
     stays on the board until it's actually resolved. */
  .row.needs.acked{animation:none}
  /* "you are here": the session running in the focused terminal. State-neutral,
     so it never competes with the needs/working/done/idle colors.
     NOTE: must not use box-shadow. The .row.needs pulse animates that property,
     and a running animation overrides normal declarations, which would silently
     hide the accent on exactly the cards you most need to find. The row's left
     border is inert (#555 for every state), so we recolor that instead.
     NOTE: no backticks or dollar-brace in here. This CSS lives inside a JS
     template literal, and either one silently corrupts the whole webview. */
  /* "You are here": the focused terminal's session. A thick blue bar + tint + bright
     name so the current card stands out even when it's a seen/grey card. Fixed blue
     on every OS. Must not use box-shadow (the .row.needs pulse animates that). */
  .row.here{border-left:6px solid #4aa0ff;
            background:rgba(74,160,255,0.16)}
  .row.here .nm{color:#cfe6ff;font-weight:700}
  .eye{width:30px;height:30px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
       padding-right:9px;border-right:1px solid var(--vscode-widget-border,#454545)}
  .eye svg{width:30px;height:30px;display:block;transition:transform .08s}
  .eye:hover svg{transform:scale(1.18)}
  .txt:hover .nm{color:var(--vscode-textLink-foreground)}
  .txt:hover~.ind{color:var(--vscode-foreground)}
  .row.needs .eye{animation:blink 2.6s infinite}
  .row.needs.acked .eye{animation:none;opacity:.6}
  @keyframes blink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.15)}}
  .meta{min-width:0;flex:1}
  .nm{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .st{font-size:10.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mt{font-size:10px;margin-top:1px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ind{font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto;padding-left:6px}
  .feed{margin:2px 8px 6px 40px;display:flex;flex-direction:column;gap:2px;max-height:160px;overflow:auto}
  .fe{font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground)}
  .fe.err{color:#ff8a8a}
  .jump{font-size:10.5px;margin-top:3px;cursor:pointer;color:var(--vscode-textLink-foreground)}
  .txt{min-width:0;flex:1;cursor:pointer}
  .eye{cursor:pointer}
  /* ---- usage card (opt-in) — pinned on top ---- */
  #usage{position:sticky;top:0;z-index:3;background:var(--vscode-sideBar-background,#1e1e1e)}
  #usage:empty{display:none}
  .ucard{margin:6px 8px 4px;padding:9px 11px 10px;border:1px solid var(--vscode-widget-border,#3a3a3a);border-radius:9px;background:var(--vscode-editorWidget-background,#242426)}
  .uhead{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;font-weight:700;margin-bottom:8px}
  .uhead .star{color:#D97757;margin-right:3px}
  .uhead .right{display:flex;align-items:center;gap:9px;font-weight:500;color:var(--vscode-descriptionForeground)}
  .uhead .ubtn{cursor:pointer;font-size:12px;opacity:.7}
  .uhead .ubtn:hover{opacity:1;color:var(--vscode-foreground)}
  .urow{margin:6px 0}
  .ulabel{display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px}
  .ulabel .pct{color:var(--vscode-descriptionForeground)}
  .ubar{height:6px;border-radius:6px;background:var(--vscode-input-background,#3a3a3f);overflow:hidden}
  .ubar > i{display:block;height:100%;border-radius:6px;transition:width .3s}
  .ureset{font-size:9.5px;color:var(--vscode-descriptionForeground);margin-top:2px}
  .unote{font-size:10px;color:var(--vscode-descriptionForeground);padding:2px 2px 4px}
  /* invite card (first run) */
  .uinvite{margin:6px 8px 4px;padding:10px 12px;border:1px solid rgba(74,160,255,.4);border-radius:9px;background:rgba(74,160,255,.08)}
  .uinvite .it{font-size:11.5px;font-weight:700;margin-bottom:4px}
  .uinvite .id{font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.55;margin-bottom:9px}
  .uinvite .ia{display:flex;gap:8px}
  .ibtn{cursor:pointer;font-size:11px;border-radius:6px;padding:4px 12px;border:1px solid var(--vscode-widget-border,#454545);user-select:none}
  .ibtn.primary{background:#4aa0ff;color:#fff;border-color:#4aa0ff}
  .ibtn:hover{filter:brightness(1.12)}
  #note{padding:0 12px 4px;font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic}
  #note:empty{display:none}
  #launchers{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:2px 8px 8px}
  #launchers:empty{display:none}
  .pill{display:flex;align-items:center;gap:6px;padding:4px 11px;border-radius:20px;font-size:11.5px;
        border:1px solid var(--vscode-widget-border,#454545);cursor:pointer;user-select:none;
        transition:transform .08s,border-color .08s}
  .pill:hover{background:var(--vscode-list-hoverBackground);border-color:var(--vscode-textLink-foreground);transform:translateY(-1px)}
  .pill:active{transform:scale(.96)}
  .pill svg{width:14px;height:14px;display:block}
  .pill.ghost{border-style:dashed;color:var(--vscode-descriptionForeground)}
  .gicon{width:14px;height:14px;border-radius:3px;background:#53A318;color:#fff;font-weight:700;
         font-size:10px;display:flex;align-items:center;justify-content:center;line-height:1}
  .pillcfg{margin-left:auto;padding:2px 6px;font-size:12px;cursor:pointer;color:var(--vscode-descriptionForeground);
           border-radius:4px;user-select:none}
  .pillcfg:hover{color:var(--vscode-foreground);background:var(--vscode-list-hoverBackground)}
</style></head><body>
<div id="usage"></div>
<div id="launchers"></div>
<div id="note"></div>
<div id="root"><div class="empty">Looking for Claude Code sessions…</div></div>
<script>
(function(){
  const root = document.getElementById("root");
  const launchersEl = document.getElementById("launchers");
  const usageEl = document.getElementById("usage");
  const noteEl = document.getElementById("note");
  function fail(msg){ try{ root.innerHTML=""; const d=document.createElement("div"); d.className="empty"; d.textContent=msg; root.appendChild(d); }catch(_){}}
  // Never leave the panel silently stuck: surface any uncaught script error.
  window.addEventListener("error", function(ev){ fail("Overlord UI error: "+((ev&&ev.message)||(ev&&ev.error)||"unknown")); });
  // Heartbeat: proves the inline script actually executed. If the panel still shows the original
  // "Looking for Claude Code sessions..." text, the script was blocked (e.g. CSP) and never ran.
  try{ var _hb=root.querySelector(".empty"); if(_hb) _hb.textContent="Overlord loaded - waiting for sessions..."; }catch(_){}
  let api; try{ api=acquireVsCodeApi(); }catch(e){ fail("Overlord: acquireVsCodeApi blocked - "+((e&&e.message)||e)); }
  // First act: tell the extension host the UI is alive, so a dead webview can be detected host-side.
  try{ if(api) api.postMessage({type:"ready"}); }catch(_){}
  const IND = ["▸","▾"];
  const rows = {};   // sid -> { row, av, nm, st, ind, feedBox, jump, feedRows:Map, pinned }
  // Hover detail uses the native title attribute (set in render). Unlike a webview DOM
  // element, the native OS tooltip is drawn by Electron outside the iframe, so it can extend
  // beyond this narrow pane into the editor area. It has a ~1s delay and plain OS styling.
  // Works now that the feed no longer re-appends rows every poll (which used to reset its timer).
  function collapse(s,n){ s=String(s==null?"":s).replace(/\\s+/g," ").trim(); return s.length>n?s.slice(0,n-1)+"…":s; }
  // Tooltip text for one event: strip markdown noise (**bold**, \`code\`), keep the
  // event's own line breaks (continuation lines indented 3 spaces under the icon),
  // collapse runs of blank lines to one. Native tooltips are plain text - layout
  // is the only formatting tool we have.
  function tipText(s){
    s=String(s==null?"":s).replace(/\\*\\*([^*]+)\\*\\*/g,"$1").replace(/\`([^\`]*)\`/g,"$1");
    const lines=s.split(/\\r?\\n/).map(function(l){ return l.replace(/\\s+/g," ").trim(); });
    const out=[]; let blank=true;
    for(const l of lines){ if(!l){ if(!blank) out.push(""); blank=true; continue; } blank=false; out.push(l); }
    while(out.length && !out[out.length-1]) out.pop();
    return out.join("\\n   ");
  }
  function eye(color){
    return '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" fill="'+color+'" '
      + 'd="M2.5 12 C6 6.8 18 6.8 21.5 12 C18 17.2 6 17.2 2.5 12 Z '
      + 'M15.2 12 A3.2 3.2 0 1 1 8.8 12 A3.2 3.2 0 1 1 15.2 12 Z '
      + 'M13.4 12 A1.4 1.4 0 1 1 10.6 12 A1.4 1.4 0 1 1 13.4 12 Z"/></svg>';
  }
  // Launcher pills. PILL_SVG is a static constant (the Claude starburst; path data
  // is plain characters - cooked-template-safe) and the ONLY innerHTML write in the bar;
  // all config-derived strings (icon, name) go through textContent.
  const PILL_SVG='<svg viewBox="0 0 24 24"><path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
  let _lk="";
  function renderLaunchers(list){
    if (!launchersEl) return;   // harness mocks may not register #launchers; be defensive
    list = list || [];
    const key = JSON.stringify(list);
    if (key === _lk) return;          // change-only: don't churn DOM (tooltip-timer lesson)
    _lk = key;
    launchersEl.innerHTML = "";
    const openCfg = function(){ if (api) api.postMessage({type:"openSettings"}); };
    list.forEach(function(l, i){
      const b = document.createElement("div");
      b.className = "pill";
      if ((l.icon || "claude") === "claude") { b.innerHTML = PILL_SVG; }
      else { const ic = document.createElement("span"); ic.textContent = l.icon; b.appendChild(ic); }
      if (l.name && l.name !== l.icon) { const nm = document.createElement("span"); nm.textContent = l.name; b.appendChild(nm); }
      b.title = "Runs: " + l.command + "\\nIn: " + (l.cwd || "~") + "\\nAuto-launch: " + (l.autoLaunch ? "on" : "off");
      b.onclick = function(){ if (api) api.postMessage({type:"launch",index:i}); };
      launchersEl.appendChild(b);
    });
    if (!list.length) {
      // No pills configured: keep the bar discoverable with a ghost instead of vanishing.
      const g = document.createElement("div");
      g.className = "pill ghost";
      g.textContent = "＋ Launch pill";
      g.title = "Configure launch pills";
      g.onclick = openCfg;
      launchersEl.appendChild(g);
    }
    const cfgBtn = document.createElement("div");
    cfgBtn.className = "pillcfg";
    cfgBtn.textContent = "✎";
    cfgBtn.title = "Configure launch pills";
    cfgBtn.onclick = openCfg;
    launchersEl.appendChild(cfgBtn);
  }
  function clearAll(){ for(const k in rows){ rows[k].row.remove(); rows[k].feedBox.remove(); delete rows[k]; } }
  function showEmpty(content, isHtml){ clearAll(); root.innerHTML=""; const d=document.createElement("div"); d.className="empty"; if(isHtml){ d.innerHTML=content; } else { d.textContent=content; } root.appendChild(d); }
  function ensureRow(sid){
    let r = rows[sid];
    if(r) return r;
    const row=document.createElement("div");
    const av=document.createElement("div"); av.className="eye";
    av.title="Jump to terminal ↗";   // zone affordance: eye = go to terminal, rest = expand/collapse
    av.onclick=(e)=>{ e.stopPropagation(); api.postMessage({type:"jump",sid}); };
    const meta=document.createElement("div"); meta.className="meta txt";
    const nm=document.createElement("div"); nm.className="nm";
    const st=document.createElement("div"); st.className="st";
    const mt=document.createElement("div"); mt.className="mt"; mt.style.display="none";
    meta.appendChild(nm); meta.appendChild(st); meta.appendChild(mt);
    const ind=document.createElement("div"); ind.className="ind";
    // The WHOLE card toggles expand/collapse (the eye alone jumps; it stops
    // propagation). Users aim at the arrow or the card body, not just the text.
    row.onclick=()=>api.postMessage({type:"cycleLevel",sid});
    row.appendChild(av); row.appendChild(meta); row.appendChild(ind);
    const feedBox=document.createElement("div"); feedBox.className="feed"; feedBox.style.display="none";
    const jump=document.createElement("div"); jump.className="jump"; jump.textContent="Jump ↗";
    jump.onclick=(e)=>{ e.stopPropagation(); api.postMessage({type:"jump",sid}); };
    r = { row, av, nm, st, mt, ind, feedBox, jump, feedRows:new Map(), pinned:true };
    // Track whether the user has scrolled up: pinned stays true only while near the bottom.
    feedBox.addEventListener("scroll", ()=>{ r.pinned = feedBox.scrollHeight - feedBox.scrollTop - feedBox.clientHeight < 24; });
    rows[sid]=r; return r;
  }
  function updateFeed(r, feed, level, bg){
    const box=r.feedBox;
    if(level<1 || !feed || !feed.length){ box.style.display="none"; return; }
    const wasHidden = box.style.display==="none";
    const wasPinned = r.pinned;                              // capture BEFORE mutating the DOM
    box.style.display="";
    const seen=new Set();
    let prev=null;
    for(const ev of feed){
      seen.add(ev.id);
      let el=r.feedRows.get(ev.id);
      if(!el){ el=document.createElement("div"); r.feedRows.set(ev.id,el); }
      const txt=ev.icon+" "+ev.text+(ev.ok===false?"  ✗":"");
      if(el.textContent!==txt) el.textContent=txt;
      const fcls="fe"+(ev.ok===false?" err":"");
      if(el.className!==fcls) el.className=fcls;
      // Keep DOM order == feed order, but ONLY move a row when it is actually out of place
      // (so a stable feed does not churn the DOM every poll and break hover).
      const ref=prev?prev.nextSibling:box.firstChild;
      if(ref!==el){ box.insertBefore(el, ref); }
      prev=el;
    }
    for(const [id,el] of r.feedRows){ if(!seen.has(id)){ el.remove(); r.feedRows.delete(id); } }
    if(box.lastChild!==r.jump){ box.appendChild(r.jump); }   // Jump link stays last; only move it if needed
    // background sessions have no terminal - a Jump link would only dead-end in a picker
    const jd = bg ? "none" : "";
    if(r.jump.style.display!==jd) r.jump.style.display=jd;
    // Auto-scroll only if we were pinned (or the feed just appeared). If the user scrolled up,
    // wasPinned is false (set by the scroll listener) and we leave their position alone.
    if(wasPinned || wasHidden){ box.scrollTop=box.scrollHeight; r.pinned=true; }
  }
  function render(sessions, error){
   try {
    if(error){ showEmpty(error, false); return; }
    if(!sessions || !sessions.length){ showEmpty("No active Claude Code sessions.<br>Start one in a terminal and it'll appear here.", true); return; }
    const lo=root.querySelector(".empty"); if(lo) lo.remove();
    const present=new Set(sessions.map(s=>s.sid));
    for(const k in rows){ if(!present.has(k)){ rows[k].row.remove(); rows[k].feedBox.remove(); delete rows[k]; } }
    let prev=null;
    for(const s of sessions){
      const r=ensureRow(s.sid);
      const lvl=s.level||0;
      // Change-only DOM writes: rewriting identical text/attrs every poll churns layout
      // under the cursor, which resets the native tooltip's hover timer (the "tooltip
      // takes 5+ seconds or never shows" bug) and costs needless repaints.
      const cls="row "+s.state+(s.here?" here":"")+(s.acked?" acked":"");
      if(r.row.className!==cls) r.row.className=cls;
      // Acknowledged (already-seen) waiting cards mute to grey; everything else keeps its state color.
      const col=s.acked?"#858585":s.color;
      if(r._color!==col){ r._color=col; r.av.innerHTML=eye(col); r.st.style.color=col; }
      // A background (headless) session has no terminal — the eye opens its transcript instead.
      const eyeTip=s.bg?"Open transcript (no terminal) ↗":"Jump to terminal ↗";
      if(r.av.title!==eyeTip) r.av.title=eyeTip;
      if(r.nm.textContent!==s.name) r.nm.textContent=s.name;
      if(r.st.textContent!==s.sub) r.st.textContent=s.sub;
      if(s.metaText){ if(r.mt.textContent!==s.metaText) r.mt.textContent=s.metaText; if(r.mt.style.display!=="") r.mt.style.display=""; } else if(r.mt.style.display!=="none"){ r.mt.style.display="none"; }
      if(r.ind.textContent!==IND[lvl]) r.ind.textContent=IND[lvl];
      // One combined tooltip for the whole session area (header + feed): static telemetry
      // lines first, then every feed event on its own line, fuller than the truncated
      // feed display. Hovering anywhere on the session shows it.
      const feedDetail=(s.feed||[]).map(function(ev){ return ev.icon+" "+tipText(ev.full||ev.text)+(ev.ok===false?" (failed)":""); }).join("\\n");
      const head=(s.tooltipLines||[]).join("\\n");
      const detail=head&&feedDetail?head+"\\n\\n"+feedDetail:(head||feedDetail);
      // Only reassign when the content actually changed: rewriting title mid-hover
      // dismisses an open native tooltip (same class of bug as the re-append churn).
      if(r.row.title!==detail){ r.row.title=detail; r.feedBox.title=detail; }
      // Place row then its feedBox in sorted order, only moving when out of place
      // (avoids per-poll DOM churn that would disrupt hover on a stable list).
      let ref = prev ? prev.nextSibling : root.firstChild;
      if(ref!==r.row){ root.insertBefore(r.row, ref); }
      ref = r.row.nextSibling;
      if(ref!==r.feedBox){ root.insertBefore(r.feedBox, ref); }
      prev=r.feedBox;
      updateFeed(r, s.feed, lvl, s.bg);
    }
   } catch(e){ fail("Overlord render error: "+((e&&e.message)||e)); }
  }
  // ---- usage card / invite (opt-in) ----
  function usageColor(sev,pct){
    if(sev==="critical"||sev==="severe"||pct>=90) return "#ff5c6c";
    if(sev==="warning"||pct>=70) return "#f5b14c";
    return "#54d6a0";
  }
  function usagePost(t){ try{ if(api) api.postMessage({type:t}); }catch(_){}}
  function uAgo(ms){ if(!ms) return ""; var s=Math.max(0,Math.round((Date.now()-ms)/1000)); if(s<45) return "just now"; var m=Math.round(s/60); if(m<60) return m+"m ago"; return Math.round(m/60)+"h ago"; }
  function uIn(ms){ if(!ms) return "soon"; var s=Math.round((ms-Date.now())/1000); if(s<=5) return "shortly"; if(s<60) return "in "+s+"s"; return "in "+Math.round(s/60)+"m"; }
  function usageNote(meta){
    if(!meta) return "";
    if(meta.state==="checking") return "checking…";
    if(meta.state==="ratelimited") return "rate-limited, retrying "+uIn(meta.nextAt);
    if(meta.state==="login") return "login expired — reopen a Claude Code session";
    if(meta.state==="ok"){ var a=uAgo(meta.fetchedAt); return a?("updated "+a):""; }
    return "";
  }
  function renderUsage(usage, enabled, dismissed, meta){
    if(!usageEl) return;
    usageEl.innerHTML="";
    if(!enabled){
      if(dismissed) return;                         // user declined — show nothing
      const c=document.createElement("div"); c.className="uinvite";
      const t=document.createElement("div"); t.className="it"; t.textContent="👁  Show your Claude usage here?";
      const d=document.createElement("div"); d.className="id";
      d.textContent="Live session & weekly limits, pinned on top. Reads your Claude login locally + one usage check a minute — 0 tokens, it just reads your numbers (not an AI call). Nothing leaves your PC except to Anthropic's own API.";
      const a=document.createElement("div"); a.className="ia";
      const en=document.createElement("div"); en.className="ibtn primary"; en.textContent="Enable"; en.onclick=function(){usagePost("usageEnable");};
      const no=document.createElement("div"); no.className="ibtn"; no.textContent="Not now"; no.onclick=function(){usagePost("usageDismiss");};
      a.appendChild(en); a.appendChild(no);
      c.appendChild(t); c.appendChild(d); c.appendChild(a); usageEl.appendChild(c);
      return;
    }
    const card=document.createElement("div"); card.className="ucard";
    const head=document.createElement("div"); head.className="uhead";
    const left=document.createElement("span");
    const star=document.createElement("span"); star.className="star"; star.textContent="✦";
    const lt=document.createElement("span"); lt.textContent="Claude usage";
    const bt=document.createElement("span"); bt.textContent="beta";
    bt.style.marginLeft="6px"; bt.style.fontSize="9px"; bt.style.textTransform="uppercase"; bt.style.letterSpacing="0.5px";
    bt.style.opacity="0.6"; bt.style.border="1px solid currentColor"; bt.style.borderRadius="4px"; bt.style.padding="0 4px"; bt.style.verticalAlign="middle";
    left.appendChild(star); left.appendChild(lt); left.appendChild(bt);
    const right=document.createElement("div"); right.className="right";
    if(usage&&usage.plan){ const p=document.createElement("span"); p.textContent=usage.plan; right.appendChild(p); }
    const rb=document.createElement("span"); rb.className="ubtn"; rb.textContent="↻"; rb.title="Refresh now"; rb.onclick=function(){usagePost("usageRefresh");};
    const xb=document.createElement("span"); xb.className="ubtn"; xb.textContent="✕"; xb.title="Turn usage off"; xb.onclick=function(){usagePost("usageDisable");};
    right.appendChild(rb); right.appendChild(xb);
    head.appendChild(left); head.appendChild(right); card.appendChild(head);
    var ustate = meta && meta.state;
    var haveRows = usage && usage.rows && usage.rows.length;
    if(ustate==="nologin"){
      var nn0=document.createElement("div"); nn0.className="unote"; nn0.textContent="No Claude login found — run any Claude Code session first.";
      card.appendChild(nn0); usageEl.appendChild(card); return;
    }
    if(!haveRows){                                   // no numbers yet — first load, or failed before any success
      var nn1=document.createElement("div"); nn1.className="unote";
      if(ustate==="ratelimited") nn1.textContent="Rate-limited by the usage API, retrying "+uIn(meta.nextAt)+".";
      else if(ustate==="login") nn1.textContent="Claude login expired — reopen a Claude Code session.";
      else nn1.textContent="Loading…";
      card.appendChild(nn1); usageEl.appendChild(card); return;
    }
    if(ustate==="ratelimited"||ustate==="login") card.style.opacity="0.72";   // last-good but stale
    var noteTxt=usageNote(meta);
    if(noteTxt){ var nn2=document.createElement("div"); nn2.className="unote"; nn2.textContent=noteTxt; card.appendChild(nn2); }
    for(const r of (usage.rows||[])){
      const row=document.createElement("div"); row.className="urow";
      const lab=document.createElement("div"); lab.className="ulabel";
      const ln=document.createElement("span"); ln.textContent=r.label;
      const pc=document.createElement("span"); pc.className="pct"; pc.textContent=r.percent+"%";
      lab.appendChild(ln); lab.appendChild(pc);
      const bar=document.createElement("div"); bar.className="ubar";
      const fill=document.createElement("i"); fill.style.width=Math.max(2,r.percent)+"%"; fill.style.background=usageColor(r.severity,r.percent);
      bar.appendChild(fill);
      row.appendChild(lab); row.appendChild(bar);
      if(r.resetText){ const rs=document.createElement("div"); rs.className="ureset"; rs.textContent="↻ "+r.resetText; row.appendChild(rs); }
      card.appendChild(row);
    }
    usageEl.appendChild(card);
  }
  window.addEventListener("message",e=>{ const m=e.data; if(!m) return;
    if(m.type==="sessions"){
      if(noteEl && noteEl.textContent!==(m.note||"")) noteEl.textContent=m.note||"";
      renderLaunchers(m.launchers); render(m.sessions,m.error);
    } else if(m.type==="usage"){
      renderUsage(m.usage, m.enabled, m.dismissed, m.meta);
    }
  });
})();
</script></body></html>`;
  }
}

function activate(context) {
  _extensionPath = context.extensionPath;
  _memento = context.globalState || null;
  provider = new OverlordViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("overlord.board", provider,
      { webviewOptions: { retainContextWhenHidden: true } }));

  // Terminal renames change tab labels; re-resolve names immediately on tab changes
  // instead of waiting for the next poll (rename otherwise lags up to a poll cycle
  // plus VS Code's own lazy Terminal.name update). Guarded: harness mocks and very
  // old VS Code lack tabGroups.
  if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabs) {
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => {
      if (_agentCache && _agentCache.length) resolveTermNames(buildSessions(_agentCache, Date.now()));
    }));
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "overlord.board.focus";
  context.subscriptions.push(statusItem);

  // Always-available launcher in the status bar, so you can start a session
  // without opening the Overlord panel.
  const newSessionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  newSessionItem.text = "$(add) New Session";
  newSessionItem.tooltip = "Overlord: start a new Claude Code session";
  newSessionItem.command = "overlord.newSession";
  newSessionItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  newSessionItem.show();
  context.subscriptions.push(newSessionItem);

  // Follow terminal focus, however it's reached: the card's jump link, a click
  // on the terminal tab itself, or Ctrl+` back into the last one.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((t) => { trackActiveTerminal(t); }));
  trackActiveTerminal(vscode.window.activeTerminal);

  if (cfg().get("device.enabled") === true) {
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
    vscode.commands.registerCommand("overlord.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:jana81000.overlord-vscode")),
    vscode.commands.registerCommand("overlord.toggleSound", async () => {
      const on = cfg().get("sound");
      await cfg().update("sound", !on, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage("Overlord sound " + (!on ? "ON 🔊" : "OFF 🔇"));
    }));

  // Auto-launch flagged launchers once per window.
  for (const l of getLaunchers()) { if (l.autoLaunch) launchLauncher(l); }

  refresh();
  const every = Math.max(1000, cfg().get("pollMs") || 2500);
  timer = setInterval(refresh, every);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Usage (opt-in): start its own slow poll, and react to the setting being toggled.
  _usageOn = usageEnabled();   // restore persisted state on activate/reload
  startUsageTimer();
  context.subscriptions.push({ dispose: () => { if (_usageTimer) clearInterval(_usageTimer); } });
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("overlord.usage")) { _usageOn = usageEnabled(); startUsageTimer(); }
    }));
  }
}

function deactivate() { if (timer) clearInterval(timer); if (_usageTimer) clearInterval(_usageTimer); try { D.stop(); } catch (_) {} }

module.exports = { activate, deactivate };
