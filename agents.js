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

// ---- activity feed: tool icons + one-line summaries (contributed by DS) ----
const TOOL_ICON = {
  read: "📖", edit: "✏️", write: "✏️", notebookedit: "✏️",
  bash: "🔧", grep: "🔎", glob: "🔎",
  webfetch: "🌐", websearch: "🌐", task: "🤖", agent: "🤖",
};

function iconForTool(name) { return TOOL_ICON[String(name || "").toLowerCase()] || "🔧"; }

function truncate(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + "…" : str;
}

function firstLine(s) {
  const lines = String(s == null ? "" : s).split(/\r?\n/);
  for (const ln of lines) { if (ln.trim()) return ln.trim(); }
  return "";
}
// Last non-empty line. For assistant messages this is the operative content
// (the question, menu prompt, or conclusion) — what the terminal shows as the
// last line — so it is the better one-line preview for the activity feed.
function lastLine(s) {
  const lines = String(s == null ? "" : s).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) return lines[i].trim(); }
  return "";
}

function basename(p) {
  const parts = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length ? parts[parts.length - 1] : "";
}

// full=true returns the untruncated label (whole command / full path / full pattern),
// used for the hover tooltip. Default (2-arg) is the truncated one-line display form.
function summarizeTool(name, input, full) {
  const nm = String(name || "");
  const key = nm.toLowerCase();
  const inp = input || {};
  const cut = (s, n) => (full ? String(s == null ? "" : s).trim() : truncate(s, n));
  const withArg = (arg) => (arg ? nm + ": " + arg : nm);
  switch (key) {
    case "bash": return withArg(inp.command ? (full ? String(inp.command).trim() : truncate(firstLine(inp.command), 80)) : "");
    case "read": case "edit": case "write": case "notebookedit":
      return withArg(inp.file_path ? (full ? String(inp.file_path) : basename(inp.file_path)) : "");
    case "grep": return withArg(inp.pattern ? cut(inp.pattern, 60) : "");
    case "glob": return withArg(inp.pattern ? cut(inp.pattern, 60) : "");
    case "task": case "agent": return inp.description ? "Task: " + cut(inp.description, 60) : "Task";
    case "webfetch": return withArg(inp.url ? cut(inp.url, 60) : "");
    case "websearch": return withArg(inp.query ? cut(inp.query, 60) : "");
    default: return nm;
  }
}

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

// Last assistant text from a line array (pure; untruncated).
function lastAssistantTextFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
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

// Last assistant text from a JSONL transcript tail (pure; caller reads the file).
// Claude Code marks a session `idle` whether it finished OR ended its turn on a
// typed question. We use this to tell the two apart.
function lastAssistantText(jsonlTail) {
  return lastAssistantTextFromLines(String(jsonlTail || "").split(/\r?\n/));
}

// Conservative: the turn's final line ends with a question mark. Superseded by
// isUserQuestion for detection; kept as a cheap primitive for callers/tests.
function endsWithQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const last = t.split(/\r?\n/).filter((x) => x.trim()).pop() || "";
  return /\?["')\]]*\s*$/.test(last.trim());
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
// Deliberately WITHOUT an "if you'd like/want" branch — that matches the
// generic completion closer "let me know if you'd like anything else" and
// would promote genuinely-done sessions to red "needs you". (Narrowing by DS.)
const LET_ME_KNOW_DIRECTIVE =
  /\blet me know\b[\s,]*(which|what|whether|how you'?d|how you would|your (choice|preference|call|answer|thoughts))/i;

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

// ---- activity feed: transcript tail -> display events (contributed by DS) ---
// Most informative single event: newest text/tool, else newest thinking/system, else null.
function pickMidEvent(events) {
  if (!events || !events.length) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "text" || events[i].kind === "tool") return events[i];
  }
  return events[events.length - 1];               // thinking / system fallback
}

const GIANT_LINE = 32 * 1024;

function splitTail(rawStr, hadOffset) {
  const parts = String(rawStr || "").split("\n");
  if (hadOffset && parts.length) parts.shift();       // first segment is a byte fragment
  while (parts.length && !parts[parts.length - 1].trim()) parts.pop();
  return parts;
}

// lines: array of raw JSONL strings (oldest->newest). Returns display events oldest->newest, max n.
function recentEvents(lines, n) {
  // First pass (newest->oldest): collect tool_use_id -> ok from every tool_result.
  const okById = new Map();
  let sawContent = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    sawContent = true;
    if (ln.length > GIANT_LINE) continue;             // skip giant lines wholesale
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    const content = (o.message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === "tool_result" && b.tool_use_id != null) {
        okById.set(b.tool_use_id, !b.is_error);
      }
    }
  }
  // Second pass (newest->oldest): build up to n display events from assistant blocks.
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim() || ln.length > GIANT_LINE) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type !== "assistant") continue;
    const content = (o.message || {}).content;
    if (!Array.isArray(content)) continue;
    const ts = o.timestamp || "";
    for (let bi = content.length - 1; bi >= 0 && out.length < n; bi--) {
      const b = content[bi];
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && b.text && b.text.trim()) {
        out.push({ id: ts + "#" + bi, kind: "text", icon: "💬", text: truncate(lastLine(b.text), 100), full: b.text.trim(), ok: undefined });
      } else if (b.type === "tool_use") {
        out.push({ id: b.id || (ts + "#" + bi), kind: "tool", icon: iconForTool(b.name), text: summarizeTool(b.name, b.input), full: summarizeTool(b.name, b.input, true), ok: okById.has(b.id) ? okById.get(b.id) : undefined });
      } else if (b.type === "thinking") {
        out.push({ id: ts + "#" + bi, kind: "thinking", icon: "💭", text: "thinking…", full: "thinking…", ok: undefined });
      }
    }
  }
  out.reverse();                                        // oldest -> newest
  if (out.length === 0 && sawContent) {
    return [{ id: "placeholder", kind: "system", icon: "⋯", text: "(large output, preview skipped)", full: "(large output, preview skipped)", ok: undefined }];
  }
  return out;
}

// ---- session telemetry (contributed by DS) ----------------------------------
// Epoch-ms from an ISO string or numeric value; null for anything invalid.
function toMs(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v) { const n = Date.parse(v); return isNaN(n) ? null : n; }
  return null;
}

// One newest->oldest scan of the transcript tail. Every field is best-effort
// within the window; giant lines are skipped with the same GIANT_LINE rule as
// recentEvents (accepted consequence: a Task whose giant tool_result line was
// skipped counts as running until its launch leaves the window).
function telemetryFromLines(lines) {
  const out = { lastUserTs: null, lastAssistantTs: null, model: null, ctxTokens: null, agentsRunning: 0 };
  if (!Array.isArray(lines)) return out;
  const resultIds = new Set();
  let launches = null;   // Map id -> true for Task/Agent tool_use seen
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim() || ln.length > GIANT_LINE) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    const msg = o.message || {};
    const content = msg.content;
    if (o.type === "assistant") {
      if (out.lastAssistantTs === null) {
        out.lastAssistantTs = toMs(o.timestamp);
        if (typeof msg.model === "string" && msg.model) out.model = msg.model;
        const u = msg.usage;
        if (u && typeof u === "object") {
          const tok = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
          if (tok > 0) out.ctxTokens = tok;
        }
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "tool_use" && /^(task|agent)$/i.test(String(b.name || "")) && b.id != null) {
            (launches = launches || new Map()).set(b.id, true);
          }
        }
      }
    } else if (o.type === "user" && !o.isMeta) {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "tool_result" && b.tool_use_id != null) resultIds.add(b.tool_use_id);
        }
        if (out.lastUserTs === null && content.some((b) => b && b.type === "text")) out.lastUserTs = toMs(o.timestamp);
      } else if (typeof content === "string" && content.trim()) {
        if (out.lastUserTs === null) out.lastUserTs = toMs(o.timestamp);
      }
    }
  }
  if (launches) for (const id of launches.keys()) { if (!resultIds.has(id)) out.agentsRunning++; }
  return out;
}

// Transcripts are append-only: if the current tail window holds no real user
// prompt, the most recent one is whatever we saw before - carry it forward so
// a busy session's "working Xm" never disappears as the prompt scrolls out.
function mergeTelemetry(prev, cur) {
  if (!cur) return prev || null;
  if (cur.lastUserTs == null && prev && prev.lastUserTs != null) {
    return Object.assign({}, cur, { lastUserTs: prev.lastUserTs });
  }
  return cur;
}

// Short display badge from a model id: strip "claude-" and a trailing date,
// then join a trailing "-N-M" numeric pair into "-N.M" (opus-4-8 -> opus-4.8).
function modelBadge(id) {
  if (typeof id !== "string" || !id) return null;
  let s = id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  s = s.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return s || null;
}

function fmtElapsed(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return null;
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
}

const CTX_WINDOW = 200000;

// The exact strings the webview shows. session = toSession output; tele =
// telemetryFromLines output (or null); nowMs = poll time. Pure -> testable.
// statusText falls back to the classic sub when nothing is known. tooltipLines
// hold only STATIC values (volatile text in a native title makes hover jittery).
function telemetryText(session, tele, nowMs) {
  const t = tele || {};
  const state = session.state;
  const stateWord =
    state === "needs" ? "needs you" :
    state === "working" ? "working" :
    state === "done" ? "just finished" : "idle";
  const anchor = state === "working" ? t.lastUserTs : t.lastAssistantTs;
  const el = anchor != null ? fmtElapsed(nowMs - anchor) : null;
  const segs = [
    el ? stateWord + " " + el : null,
    session.waitingFor || null,
    modelBadge(t.model),
    t.agentsRunning > 0 ? t.agentsRunning + " agent" + (t.agentsRunning > 1 ? "s" : "") : null,
  ].filter(Boolean);
  const statusText = segs.length ? (el ? segs : [stateWord].concat(segs)).join(" · ") : session.sub;

  const metaSegs = [];
  // Over the nominal window (cache-read counts can exceed 200k after context
  // editing/compaction): a percentage would lie, so show the real used amount.
  if (t.ctxTokens != null) {
    metaSegs.push(t.ctxTokens > CTX_WINDOW
      ? "ctx " + Math.round(t.ctxTokens / 1000) + "k"
      : "ctx " + Math.round((t.ctxTokens / CTX_WINDOW) * 100) + "%");
  }
  if (session.startedAt != null) { const up = fmtElapsed(nowMs - session.startedAt); if (up) metaSegs.push("up " + up); }
  const metaText = metaSegs.length ? metaSegs.join(" · ") : null;

  const tooltipLines = [];
  if (t.model) tooltipLines.push("model: " + t.model);
  if (t.ctxTokens != null) {
    tooltipLines.push(t.ctxTokens > CTX_WINDOW
      ? "context: " + Math.round(t.ctxTokens / 1000) + "k tokens used"
      : "context: " + Math.round(t.ctxTokens / 1000) + "k/" + Math.round(CTX_WINDOW / 1000) + "k tokens");
  }
  if (t.agentsRunning > 0) tooltipLines.push("subagents: " + t.agentsRunning);
  if (session.startedAt != null) tooltipLines.push("started: " + new Date(session.startedAt).toLocaleString());
  if (session.cwd) tooltipLines.push("dir: " + session.cwd);
  return { statusText, metaText, tooltipLines };
}

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
    // native-record extras used by telemetryText (his path)
    startedAt: toMs(a.startedAt),
    waitingFor: a.waitingFor || null,
    // opts-driven extras used by metaLine (our path; device screen consumes it)
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

module.exports = {
  COLOR, LABEL, ORDER, JUMP_LABEL, folderName, ancestorsOf, sessionForTerminal, parseAgents, toSession,
  lastAssistantText, lastAssistantTextFromLines, endsWithQuestion,
  isUserQuestion, asksApproval, asksDirectiveQuestion, awaitReason, awaitsUser,
  shortModel, fmtTokens, fmtDuration, ctxPct, jumpLabel, metaLine,
  // activity feed + telemetry (contributed by DS)
  truncate, firstLine, lastLine, iconForTool, summarizeTool,
  splitTail, recentEvents, pickMidEvent, GIANT_LINE,
  toMs, telemetryFromLines, mergeTelemetry, modelBadge, fmtElapsed, telemetryText, CTX_WINDOW,
};
