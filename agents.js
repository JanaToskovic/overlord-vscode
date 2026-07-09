// Pure, dependency-free logic for Overlord's data source.
//
// Overlord reads Claude Code's own session supervisor via `claude agents --json`
// (no hooks, no state files). This module turns those native records into the
// display model the extension paints. It touches no VS Code APIs so it can be
// unit-tested in plain Node.
//
// Native record shape (from `claude agents --json`):
//   { pid, cwd, kind, startedAt, sessionId, name, status, waitingFor? }
//   status ∈ { "busy", "waiting", "idle" }; waitingFor is set when waiting
//   (e.g. "permission prompt").

const COLOR = { needs: "#ff5c6c", working: "#f5b14c", done: "#54d6a0", idle: "#858585" };
const LABEL = { needs: "Needs you", working: "Working", done: "Done", idle: "Idle" };
const ORDER = { needs: 0, working: 1, done: 2, idle: 3 };
const JUMP_LABEL = { needs: "Answer now", working: "Watch / interrupt", done: "Continue", idle: "Continue" };

// ---- card sub-line formatters (pure) --------------------------------------
function shortModel(model) { return String(model || "").replace(/^claude-/, ""); }

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n <= 0) return "";
  return n < 1000 ? String(n) : Math.round(n / 1000) + "k";
}

function fmtDuration(ms) {
  let s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 0) s = 0;
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h" + (m % 60) + "m";
}

function ctxPct(tokens) {
  tokens = Number(tokens) || 0;
  if (tokens <= 0) return null;
  const window = tokens > 200000 ? 1000000 : 200000;
  return Math.round((tokens / window) * 100);
}

function jumpLabel(state) { return JUMP_LABEL[state] || "Open"; }

function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length ? parts[parts.length - 1] : "";
}

// ---- terminal <-> session matching (pure) ----------------------------------
// Every pid from `pid` up to the root, cycle-safe. `map` is pid -> ppid.
function ancestorsOf(pid, map) {
  const set = new Set();
  let p = Number(pid), guard = 0;
  while (p && p > 1 && !set.has(p) && guard++ < 40) { set.add(p); p = map.get(p); }
  return set;
}

// Which session runs inside the terminal whose shell process is `termPid`?
// A terminal's shell is an ancestor of the session process it hosts, so walk
// up from each session. Returns the session id, or null when nothing resolves —
// marking no card beats marking the wrong one.
function sessionForTerminal(sessions, termPid, map) {
  termPid = Number(termPid) || 0;
  if (!termPid || !map || !map.size) return null;
  for (const s of sessions || []) {
    if (!s || !s.pid) continue;
    if (ancestorsOf(s.pid, map).has(termPid)) return s.sid || s.sessionId || null;
  }
  return null;
}

function parseAgents(stdout) {
  const data = JSON.parse(stdout || "[]");
  return Array.isArray(data) ? data : [];
}

// Last assistant text from a JSONL transcript tail (pure; caller reads the file).
// Claude Code marks a session `idle` whether it finished OR ended its turn on a
// typed question. We use this to tell the two apart.
function lastAssistantText(jsonlTail) {
  const lines = String(jsonlTail || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type !== "assistant") continue;
    const c = (o.message || {}).content;
    let t = "";
    if (Array.isArray(c)) { for (const b of c) if (b && b.type === "text") t += b.text || ""; }
    else if (typeof c === "string") t = c;
    if (t.trim()) return t.trim();
  }
  return "";
}

// Does this turn end on a GENUINE question that needs the user's answer, as
// opposed to a rhetorical question the assistant answers itself
// ("How does it work? Like this: ...")? Agent View reports both a finished turn
// and a plain typed question as `idle`; this is how we tell a typed question
// apart. (Tool-based questions like AskUserQuestion already surface natively as
// `waiting`, so they never reach here.)
//
// Heuristic: peel trailing ASIDES — parenthetical remarks and option-list
// items — then check whether the turn ends on a question. This catches a real
// question followed by a "(or we could pause)" note, while still rejecting a
// question with a substantive self-answer after it.
function isUserQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // Last substantive line, skipping trailing list items that hold no question
  // (e.g. an enumerated set of options presented before the closing question).
  const lines = t.split(/\r?\n/);
  let line = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^(\d+[.)]|[-*•])\s+/.test(l) && !l.includes("?")) continue;
    line = l; break;
  }
  // Peel trailing parenthetical asides: "Which approach? (or pause…)" -> "Which approach?"
  let prev;
  do { prev = line; line = line.replace(/\s*\([^()]*\)\s*$/, "").trim(); } while (line !== prev);
  return /\?["')\]]*\s*$/.test(line);
}

// Some turns need you without any "?" — an approval / go-ahead request phrased
// as an imperative ("say go and I'll…", "give me the green light"). These read
// as `idle` to Agent View and carry no question mark, so we match a curated set
// of high-precision asks. "let me know" only counts when it's directive
// (followed by a choice), never as a bare closing courtesy.
const APPROVAL = [
  /\bsay (go|the word)\b/i,
  /\byour (go[- ]?ahead|sign[- ]?off|approval)\b/i,
  /\bgive (me |us )?(the |a |your )?(go[- ]?ahead|green[- ]?light)\b/i,
  /\byour green[- ]?light\b/i,
  /\bgreen[- ]?light (and i'?ll|to (go|proceed|start|ship))\b/i,
  /\b(confirm|approve|approved|say go|sign off)\b[^.?!\n]{0,40}\band i'?ll\b/i,
  /\bif you'?re (good|happy|ok|okay|fine|cool|on board) with (this|that|it|the)\b/i,
  /\bready when you are\b/i,
  /\bstanding by\b/i,
  /\baw(ait|aiting) your\b/i,
  // conditional-on-approval trailing statement: "…? If yes, I'll start right away."
  /\bif (yes|so|that works|that'?s good|you'?re good|good|approved|ok|okay)\b[^.?!\n]{0,24}\bi'?ll\b/i,
];
const LET_ME_KNOW_DIRECTIVE =
  /\blet me know\b[\s,]*(which|what|whether|how you'?d|how you would|your (choice|preference|call|answer|thoughts)|if you'?d? (like|want|prefer|rather))/i;

function asksApproval(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (LET_ME_KNOW_DIRECTIVE.test(t)) return true;
  return APPROVAL.some((re) => re.test(t));
}

// A DIRECTIVE question buried mid-paragraph still needs you, even when a
// courtesy sentence follows the "?" ("Want me to proceed…? Either is quick.").
// isUserQuestion can't peel trailing statements without breaking its
// rhetorical-question guard, so this matches a curated set of second-person
// asks that are never rhetorical — but only inside the FINAL paragraph, so a
// mid-turn "want me to…?" followed by more narrated work stays quiet.
const DIRECTIVE_Q = [
  /\bwant me to\b/i,
  /\bwould you (rather|prefer|like me to)\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bshall we\b/i,
  /\bdo you want (me|us) to\b/i,
  /\b(ok|okay|good|fine|safe|clear|happy|ready) to proceed\b/i,
  /\bproceed this way\b/i,
];
function asksDirectiveQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const paras = t.split(/\n\s*\n/);
  const last = paras[paras.length - 1];
  // Question-ending fragments of the last paragraph ("?" cut at sentence ends);
  // a "?" inside a URL never pairs with a directive phrase, so it can't match.
  const frags = last.match(/[^.!?\n]*\?/g) || [];
  return frags.some((f) => DIRECTIVE_Q.some((re) => re.test(f)));
}

// Why the session needs you (for the subtitle), or null if it doesn't.
function awaitReason(text) {
  if (isUserQuestion(text)) return "typed a question";
  if (asksDirectiveQuestion(text)) return "typed a question";
  if (asksApproval(text)) return "awaiting your reply";
  return null;
}

function awaitsUser(text) { return awaitReason(text) !== null; }

// Map one native record -> display session.
//   status "waiting" -> red   "needs you"   (subtitle shows waitingFor)
//   status "busy"    -> amber "working"
//   status "idle"    -> grey  "idle", OR a short green "done" flash if we just
//                       observed this session transition busy->idle. The green
//                       is the ONLY derived cue; everything else is native.
// opts: { finishedAtMs, nowMs, doneFlashMs, termName }
function toSession(a, opts = {}) {
  const raw = a.status || "idle";
  let state;
  if (raw === "waiting") state = "needs";
  else if (raw === "busy") state = "working";
  else {
    const f = opts.finishedAtMs;
    state = f && opts.nowMs - f < (opts.doneFlashMs || 0) ? "done" : "idle";
  }
  const sub =
    state === "needs" ? (a.waitingFor ? "needs you · " + a.waitingFor : "needs you") :
    state === "working" ? "working" :
    state === "done" ? "just finished" : "idle";
  return {
    sid: a.sessionId,
    pid: a.pid || 0,
    name: opts.termName || folderName(a.cwd) || a.name || "session",
    cwd: a.cwd || "",
    raw,
    state,
    color: COLOR[state],
    label: LABEL[state],
    sub,
    jumpLabel: JUMP_LABEL[state] || "Open",
    model: shortModel(opts.model),
    ctxTokens: Number(opts.ctxTokens) || 0,
    ctxPct: ctxPct(opts.ctxTokens),
    sinceMs: opts.statusSinceMs ? Math.max(0, (opts.nowMs || 0) - opts.statusSinceMs) : 0,
    uptimeMs: opts.startedAtMs ? Math.max(0, (opts.nowMs || 0) - opts.startedAtMs) : 0,
  };
}

// Compose the sidebar sub-line: "working 41s · fable-5 · ctx 268k · 27% · up 3h45m".
// The head bit keeps the needs-you reason; other segments append only when present.
function metaLine(s) {
  const bits = [];
  if (s.state === "needs") bits.push(s.sub);
  else if (s.state === "done") bits.push("just finished");
  else bits.push((s.state === "working" ? "working" : "idle") +
                 (s.sinceMs ? " " + fmtDuration(s.sinceMs) : ""));
  if (s.model) bits.push(s.model);
  if (s.ctxTokens) bits.push("ctx " + fmtTokens(s.ctxTokens) + (s.ctxPct != null ? " · " + s.ctxPct + "%" : ""));
  if (s.uptimeMs) bits.push("up " + fmtDuration(s.uptimeMs));
  return bits.join(" · ");
}

module.exports = { COLOR, LABEL, ORDER, JUMP_LABEL, folderName, ancestorsOf, sessionForTerminal, parseAgents, toSession, lastAssistantText, isUserQuestion, asksApproval, asksDirectiveQuestion, awaitReason, awaitsUser, shortModel, fmtTokens, fmtDuration, ctxPct, jumpLabel, metaLine };
