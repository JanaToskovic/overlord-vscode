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

// The conversation's identity, for "have I already seen this?": the uuid of the
// last real user/assistant message. Bookkeeping records the CLI appends
// (permission-mode, hook/system entries) and bare file touches leave this
// unchanged, so an ack keyed to it survives them. An mtime cannot: ANY write
// moves it, and a transcript whose last message was 8h old kept getting touched,
// which silently un-greyed cards the user had already seen (2026-07-16).
// Returns "" when the tail holds no message, so the caller can fall back.
function lastMessageIdFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type !== "assistant" && o.type !== "user") continue;
    if (o.uuid) return String(o.uuid);
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
  // Past-tense "approved" removed: it fires on descriptions of an ALREADY-granted
  // approval ("the plan is approved and I'll start it") which is a statement, not a
  // request for the user's go-ahead. Imperatives directed at the user stay.
  // (2026-07-20: a "…approved and I'll…" status line falsely blinked a card red.)
  /\b(confirm|approve|say go|sign off)\b[^.?!\n]{0,40}\band i'?ll\b/i,
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

// Mention vs use: text the assistant PRESENTS — quoted spans, code fences,
// blockquotes, draft blocks between paired --- lines — is the assistant talking
// ABOUT an ask, not asking. A message showing the user a draft reply that
// contained "say the word" kept a card red for six hours (2026-07-10). Genuine
// asks never live inside these regions, so stripping them costs no recall.
function stripArtifacts(text) {
  let t = String(text || "");
  t = t.replace(/```[\s\S]*?(```|$)/g, " ");                          // code fences (incl. unterminated)
  t = t.replace(/(^|\n)[ \t]*---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(?=\n|$)/g, "$1 ");  // paired --- draft blocks
  t = t.replace(/(^|\n)[ \t]*>[^\n]*/g, "$1 ");                       // blockquote lines
  t = t.replace(/"[^"\n]{2,}"/g, " ");                                // straight double-quoted spans
  t = t.replace(/“[^”\n]{2,}”/g, " ");                 // curly-quoted spans
  t = t.replace(/`[^`\n]+`/g, " ");                                   // inline code
  return t;
}

// Why the session needs you (for the subtitle), or null if it doesn't.
// isUserQuestion runs on the RAW text (its end-of-turn logic is position-based
// and immune to mid-text quotes); the phrase matchers run on the stripped text.
function awaitReason(text) {
  if (isUserQuestion(text)) return "typed a question";
  const bare = stripArtifacts(text);
  if (asksDirectiveQuestion(bare)) return "typed a question";
  if (asksApproval(bare)) return "awaiting your reply";
  return null;
}

function awaitsUser(text) { return awaitReason(text) !== null; }

// F2 — busy-but-awaiting: `claude agents` reports `busy` while ANY shell the
// session started is still alive, even after the turn ended on a question
// (e.g. a `code <file>` that never exits). If the transcript has been silent
// past `staleMs` AND the last message awaits the user, the session needs you.
// Both conditions required: a genuinely working session writes blocks steadily,
// and a quiet one whose last message isn't an ask stays "working".
const BUSY_STALE_MS = 1200000;   // 20 min
function busyAwaitReason(lastText, mtimeMs, nowMs, staleMs) {
  if (typeof mtimeMs !== "number" || !isFinite(mtimeMs)) return null;
  if ((nowMs - mtimeMs) <= (staleMs || BUSY_STALE_MS)) return null;
  return awaitReason(lastText);
}

// F1 — resilient polling: one failed `claude agents` spawn must not blank the
// board (the CLI vanishes from disk briefly during its own self-update).
//   "repost" -> show the last good board with a reconnecting hint
//   "wait"   -> nothing good to show yet (cold start); keep the placeholder
//   "error"  -> 3+ consecutive failures: a real outage, surface it
function pollFailureAction(consecutiveFails, hasLastGood) {
  if (consecutiveFails < 3) return hasLastGood ? "repost" : "wait";
  return "error";
}

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
// A backgrounded Task/Agent returns this immediate ack as its FIRST tool_result;
// it means "launched", not "finished". Real completion arrives later as a
// task-notification. Mistaking the ack for completion is why a backgrounded
// agent never showed on the board.
const _AGENT_ACK = /Async agent launched successfully/i;
const _NOTIF_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/g;
// A backgrounded AGENT's completion notification is keyed to its agentId and carries NO
// <tool-use-id> at all (unlike a backgrounded Bash task, whose notification does). Its
// launch ack is the only place the agentId appears next to the launch's tool_use id:
//   ack   -> tool_result(tool_use_id: toolu_…) "Async agent launched successfully … agentId: a7fd…"
//   done  -> <task-notification><task-id>a7fd…</task-id>
// So we learn the launch->agentId pairing from the ack and clear the launch when a
// task-id notification names that agentId. Without this bridge a backgrounded agent has
// no done signal at all and sits in the pending set forever, so the card's agent badge
// only ever counts UP and shows phantom agents long after they finished (2026-07-17).
const _ACK_AGENT_ID = /agentId:\s*([A-Za-z0-9_-]+)/;
const _NOTIF_TASK_ID = /<task-id>([^<]+)<\/task-id>/g;
// An agent KILLED before it finishes never sends a completion notification, so the
// TaskStop receipt is its only end-of-life signal. It is filed under TaskStop's own
// tool_use id, not the agent's launch id, so the agentId in its text is the only link back.
const _STOP_TASK_ID = /Successfully stopped task:\s*([A-Za-z0-9_-]+)/;
function _contentText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string") ? x.text : "").join(" ");
  return "";
}

// Returns per-window agent signals in addition to the timing/model/ctx fields:
//   agentLaunches: [{id, desc}] Task/Agent tool_use seen in this window
//   agentDoneIds:  [id]         completion ids seen (real tool_results + task-
//                               notifications + giant-line harvest; excludes the
//                               "launched" ack). The host merges these across polls
//                               (mergeTelemetry) because a backgrounded agent's
//                               launch scrolls out of the window while it runs.
function telemetryFromLines(lines) {
  const out = { lastUserTs: null, lastAssistantTs: null, model: null, ctxTokens: null, agentsRunning: 0, agentLaunches: [], agentDoneIds: [] };
  if (!Array.isArray(lines)) return out;
  const resultIds = new Set();
  const launches = new Map();   // id -> description (Task/Agent tool_use seen)
  const ackAgentIds = new Map();  // launch tool_use id -> agentId (learned from the launch ack)
  const notifTaskIds = new Set(); // agentIds named by a <task-id> notification in this window
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    // A backgrounded agent's completion is a `task-notification` (a queue-operation
    // record, not a normal tool_result) that references the launch id. It's the only
    // "done" signal a backgrounded agent emits, so harvest it from the raw line
    // regardless of record type. (JSON tool_results use "tool_use_id" with an
    // underscore, so this hyphenated tag never collides with them.)
    if (ln.indexOf("tool-use-id>") >= 0) { let m; _NOTIF_ID.lastIndex = 0; while ((m = _NOTIF_ID.exec(ln)) !== null) resultIds.add(m[1]); }
    // Backgrounded agents report done by agentId instead (see _NOTIF_TASK_ID above).
    if (ln.indexOf("task-id>") >= 0) { let m; _NOTIF_TASK_ID.lastIndex = 0; while ((m = _NOTIF_TASK_ID.exec(ln)) !== null) notifTaskIds.add(m[1]); }
    if (ln.length > GIANT_LINE) {
      // Oversized lines are skipped for full JSON parse (cost), but a Task
      // subagent's completion result often IS exactly such a line. Cheaply
      // harvest any tool_use_id so the launch still gets marked done — otherwise
      // the card shows a phantom "1 agent" until the launch scrolls out of view.
      // A running subagent has no result line yet, so nothing here can false-clear it.
      let mm; const re = /"tool_use_id"\s*:\s*"([^"]+)"/g;
      while ((mm = re.exec(ln)) !== null) resultIds.add(mm[1]);
      continue;
    }
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
            if (!launches.has(b.id)) launches.set(b.id, (b.input && b.input.description) || "");
          }
        }
      }
    } else if (o.type === "user" && !o.isMeta) {
      if (Array.isArray(content)) {
        for (const b of content) {
          // Skip a backgrounded agent's immediate "Async agent launched
          // successfully" ack — that is a launch receipt, not completion. Harvest the
          // agentId out of it first: it is the only link between this launch and the
          // task-id notification that will later announce the agent finished.
          if (b && b.type === "tool_result" && b.tool_use_id != null) {
            const txt = _contentText(b.content);
            if (_AGENT_ACK.test(txt)) { const am = _ACK_AGENT_ID.exec(txt); if (am) ackAgentIds.set(b.tool_use_id, am[1]); }
            else {
              const sm = _STOP_TASK_ID.exec(txt);   // killed agent: end of life, same as a notification
              if (sm) notifTaskIds.add(sm[1]);
              resultIds.add(b.tool_use_id);
            }
          }
        }
        if (out.lastUserTs === null && content.some((b) => b && b.type === "text")) out.lastUserTs = toMs(o.timestamp);
      } else if (typeof content === "string" && content.trim()) {
        if (out.lastUserTs === null) out.lastUserTs = toMs(o.timestamp);
      }
    }
  }
  // Ack + notification both inside this window (e.g. the one-shot seed read over the
  // whole file): resolve the pairing here so agentDoneIds is complete on its own.
  for (const [launchId, agentId] of ackAgentIds) if (notifTaskIds.has(agentId)) resultIds.add(launchId);
  for (const [id, desc] of launches) {
    out.agentLaunches.push({ id, desc });
    if (!resultIds.has(id)) out.agentsRunning++;   // window-only count (host merges across polls)
  }
  out.agentDoneIds = [...resultIds];
  // Carried across polls by mergeTelemetry: an ack and its notification usually land in
  // DIFFERENT 64KB windows, so neither side can resolve the pairing alone.
  out.agentAcks = [...ackAgentIds].map(([id, agentId]) => ({ id, agentId }));
  out.notifTaskIds = [...notifTaskIds];
  return out;
}

// Transcripts are append-only: if the current tail window holds no real user
// prompt, the most recent one is whatever we saw before - carry it forward so
// a busy session's "working Xm" never disappears as the prompt scrolls out.
function mergeTelemetry(prev, cur) {
  if (!cur) return prev || null;
  const merged = Object.assign({}, cur);
  // Sticky last user prompt across window slides.
  if (merged.lastUserTs == null && prev && prev.lastUserTs != null) merged.lastUserTs = prev.lastUserTs;
  // Sticky backgrounded-agent tracking. A backgrounded agent doesn't block the
  // session, so its launch line scrolls out of the read window while it keeps
  // running; only its launch (once) and its completion (a task-notification, once)
  // ever pass through the window. So accumulate: carry the prior pending set,
  // clear anything completed this scan, add launches not yet completed.
  const pending = Object.assign({}, (prev && prev.pendingAgents) || {});
  const done = new Set(cur.agentDoneIds || []);
  for (const id of done) delete pending[id];
  for (const l of (cur.agentLaunches || [])) if (!done.has(l.id)) pending[l.id] = l.desc || "";
  // Sticky launch->agentId pairings: the ack that reveals a backgrounded agent's agentId
  // scrolls out of the window long before the notification announcing it finished arrives,
  // so the pairing has to outlive the window the ack was seen in.
  const agentIdOf = Object.assign({}, (prev && prev.agentIdOf) || {});
  for (const a of (cur.agentAcks || [])) agentIdOf[a.id] = a.agentId;
  const notified = new Set(cur.notifTaskIds || []);
  if (notified.size) for (const id of Object.keys(pending)) if (notified.has(agentIdOf[id])) delete pending[id];
  merged.pendingAgents = pending;
  // Keep only pairings still awaiting a notification, so this can't grow without bound.
  merged.agentIdOf = {};
  for (const id of Object.keys(pending)) if (agentIdOf[id]) merged.agentIdOf[id] = agentIdOf[id];
  merged.agentsRunning = Object.keys(pending).length;   // the displayed count
  return merged;
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
  // Status line carries only state + reason + subagents. The model lives on the
  // meta line: a long needs-you reason ("awaiting your reply") used to push the
  // model badge past the sidebar's ellipsis, so red cards seemed to lose it.
  const segs = [
    el ? stateWord + " " + el : null,
    session.waitingFor || null,
    t.agentsRunning > 0 ? "🤖 " + t.agentsRunning : null,   // agent icon (matches the feed), e.g. "🤖 2"
  ].filter(Boolean);
  const statusText = segs.length ? (el ? segs : [stateWord].concat(segs)).join(" · ") : session.sub;

  const metaSegs = [];
  // Fixed order, always-on where known: folder · model · ctx · uptime. A stable
  // position for each fact beats de-duplication in a glanceable board.
  const folder = folderName(session.cwd);
  if (folder) metaSegs.push(folder);
  const mb = modelBadge(t.model);
  if (mb) metaSegs.push(mb);
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

// ---- Claude usage (opt-in) -------------------------------------------------
// Shape the /api/oauth/usage response into display rows. Pure -> testable.
// `meta` carries the plan label bits read from the credentials file
// (subscriptionType + rateLimitTier); no secrets. Percentages are 0-100.
function usageLabel(lim) {
  if (lim.kind === "session") return "Session · 5h";
  if (lim.kind === "weekly_all") return "Weekly · all models";
  if (lim.kind === "weekly_scoped") {
    const nm = lim.scope && lim.scope.model && lim.scope.model.display_name;
    return "Weekly · " + (nm || "model");
  }
  return String(lim.kind || "limit").replace(/_/g, " ");
}
// Format a minor-unit money amount (e.g. 1500 cents, exponent 2 -> "€15.00").
function fmtMoney(minor, exponent, currency) {
  if (minor == null || isNaN(Number(minor))) return null;
  const exp = exponent == null ? 2 : exponent;
  const v = Number(minor) / Math.pow(10, exp);
  const sym = currency === "EUR" ? "€" : currency === "USD" ? "$" : currency === "GBP" ? "£" : "";
  const s = v.toFixed(exp);
  return sym ? sym + s : (currency ? s + " " + currency : s);
}
// Extra-usage / pay-as-you-go credits, from the `spend` (preferred) or `extra_usage`
// block. Returns null unless the user has credits turned ON (is_enabled/enabled), so
// the card only shows the row for people who actually use them.
function parseCredits(raw) {
  if (!raw || typeof raw !== "object") return null;
  const eu = raw.extra_usage || null, sp = raw.spend || null;
  if (!eu && !sp) return null;
  // "Turned on" (the claude.ai toggle) is NOT the same as `is_enabled`/`enabled`, which
  // mean "actively drawing credits" and require a positive balance. A user who flipped
  // the toggle but has €0 balance reports enabled:false with disabled_reason
  // "out_of_credits" — that still means it's turned ON. So treat either as on.
  const reason = (sp && sp.disabled_reason) || (eu && eu.disabled_reason) || null;
  const enabled = (eu && eu.is_enabled === true) || (sp && sp.enabled === true) || reason === "out_of_credits";
  if (!enabled) return null;
  let usedMinor = null, limitMinor = null, currency = null, exp = 2, pct = 0, sev = "normal";
  if (sp && sp.used && sp.limit) {
    usedMinor = sp.used.amount_minor; limitMinor = sp.limit.amount_minor;
    currency = sp.used.currency || sp.limit.currency || null;
    exp = sp.used.exponent != null ? sp.used.exponent : 2;
    pct = Math.round(Number(sp.percent) || 0); sev = sp.severity || "normal";
  } else if (eu) {
    usedMinor = eu.used_credits; limitMinor = eu.monthly_limit;
    currency = eu.currency || null;
    exp = eu.decimal_places != null ? eu.decimal_places : 2;
    pct = Math.round(Number(eu.utilization) || 0);
  }
  const detail = [fmtMoney(usedMinor, exp, currency), fmtMoney(limitMinor, exp, currency)].filter((x) => x != null).join(" / ");
  return { enabled: true, label: "Usage credits", percent: Math.max(0, Math.min(100, pct)), severity: sev, detail: detail || null };
}
function parseUsage(raw, meta) {
  const out = { plan: null, rows: [], error: null, credits: null };
  const m = meta || {};
  if (m.subscriptionType) {
    let plan = String(m.subscriptionType).charAt(0).toUpperCase() + String(m.subscriptionType).slice(1);
    const mult = String(m.rateLimitTier || "").match(/(\d+)x/);
    if (mult) plan += " · " + mult[1] + "x";
    out.plan = plan;
  }
  if (!raw || typeof raw !== "object") { out.error = "no data"; return out; }
  const list = Array.isArray(raw.limits) ? raw.limits : [];
  for (const lim of list) {
    if (!lim || lim.percent == null) continue;
    out.rows.push({
      label: usageLabel(lim),
      group: lim.group || null,
      percent: Math.max(0, Math.min(100, Math.round(Number(lim.percent) || 0))),
      severity: lim.severity || "normal",
      resetsAt: lim.resets_at || null,
    });
  }
  // Older/simpler payloads without a limits array: fall back to the two blocks.
  if (!out.rows.length) {
    const b = (o, label, group) => { if (o && o.utilization != null) out.rows.push({ label, group, percent: Math.round(o.utilization), severity: "normal", resetsAt: o.resets_at || null }); };
    b(raw.five_hour, "Session · 5h", "session");
    b(raw.seven_day, "Weekly · all models", "weekly");
  }
  out.credits = parseCredits(raw);
  return out;
}
// "resets in 1h12m" / "resets in 5d" from an ISO timestamp. Pure -> testable.
function fmtUsageReset(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const ms = t - (nowMs || 0);
  if (ms <= 0) return "resetting…";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return "resets in " + mins + "m";
  const hrs = Math.floor(mins / 60), rem = mins % 60;
  if (hrs < 24) return "resets in " + hrs + "h" + String(rem).padStart(2, "0") + "m";
  return "resets in " + Math.round(hrs / 24) + "d";
}

module.exports = {
  parseUsage, fmtUsageReset, usageLabel, fmtMoney, parseCredits,
  COLOR, LABEL, ORDER, JUMP_LABEL, folderName, ancestorsOf, sessionForTerminal, parseAgents, toSession,
  lastAssistantText, lastAssistantTextFromLines, lastMessageIdFromLines, endsWithQuestion,
  isUserQuestion, asksApproval, asksDirectiveQuestion, awaitReason, awaitsUser,
  busyAwaitReason, BUSY_STALE_MS, pollFailureAction, stripArtifacts,
  shortModel, fmtTokens, fmtDuration, ctxPct, jumpLabel, metaLine,
  // activity feed + telemetry (contributed by DS)
  truncate, firstLine, lastLine, iconForTool, summarizeTool,
  splitTail, recentEvents, pickMidEvent, GIANT_LINE,
  toMs, telemetryFromLines, mergeTelemetry, modelBadge, fmtElapsed, telemetryText, CTX_WINDOW,
};
