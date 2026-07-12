// Unit tests for agents.js — run with: node test-agents.js
const assert = require("assert");
const A = require("./agents");

const now = 1_000_000;
const cases = [
  // record, opts, expected state, expected subtitle
  [{ sessionId: "a", status: "busy", cwd: "C:/x/proj" }, {}, "working", "working"],
  [{ sessionId: "b", status: "waiting", waitingFor: "permission prompt" }, {}, "needs", "needs you · permission prompt"],
  [{ sessionId: "b2", status: "waiting" }, {}, "needs", "needs you"],
  [{ sessionId: "c", status: "idle" }, {}, "idle", "idle"],
  [{ sessionId: "d", status: "idle" }, { finishedAtMs: now - 2000, nowMs: now, doneFlashMs: 12000 }, "done", "just finished"],
  [{ sessionId: "e", status: "idle" }, { finishedAtMs: now - 20000, nowMs: now, doneFlashMs: 12000 }, "idle", "idle"],
];
for (const [rec, opts, state, sub] of cases) {
  const s = A.toSession(rec, opts);
  assert.strictEqual(s.state, state, `state for ${rec.sessionId}: got ${s.state}`);
  assert.strictEqual(s.sub, sub, `sub for ${rec.sessionId}: got ${s.sub}`);
}

// name resolution: explicit terminal tab name wins, else cwd folder, else auto name
assert.strictEqual(A.toSession({ sessionId: "f", status: "idle", cwd: "C:/x/proj", name: "auto-1" }, { termName: "my-tab" }).name, "my-tab");
assert.strictEqual(A.toSession({ sessionId: "g", status: "idle", cwd: "C:/x/proj", name: "auto-1" }, {}).name, "proj");
assert.strictEqual(A.toSession({ sessionId: "h", status: "idle", cwd: "", name: "auto-1" }, {}).name, "auto-1");

// parseAgents is defensive
assert.deepStrictEqual(A.parseAgents(""), []);
assert.deepStrictEqual(A.parseAgents("null"), []);
assert.strictEqual(A.parseAgents('[{"sessionId":"x"}]').length, 1);

// genuine-question detection (a question that needs the user's answer, vs. a
// rhetorical question the assistant answers itself). Distinguishes them by
// peeling trailing asides — parentheticals, option-lists, closing notes — and
// checking whether the turn then ends on a real question.
const Q = A.isUserQuestion;
// clean trailing questions
assert.strictEqual(Q("rather than a fixed trailing 30 days?"), true);
assert.strictEqual(Q("Which one, foo or bar?)"), true);            // trailing bracket
assert.strictEqual(Q("Want me to update the spec to match, so the docs agree?"), true);
// no question at all
assert.strictEqual(Q("Done. All tests pass."), false);
assert.strictEqual(Q(""), false);
// rhetorical: '?' is self-answered by substantive prose after it
assert.strictEqual(Q("How will this work? I'll explain: first we do X, then Y, then Z."), false);
assert.strictEqual(Q("line one?\nnow doing the work"), false);     // '?' on earlier line, statement after
// THE BUG: a genuine question followed by a parenthetical aside is still a question
assert.strictEqual(
  Q("Which approach? (Or if you'd rather pause here and pick up the build later — that's completely fine too; the whole PC side can be built and tested now regardless.)"),
  true);
// genuine question after an option list (question on the final line)
assert.strictEqual(Q("How do you want to execute this?\n1. Subagent-Driven\n2. Inline Execution\nWhich approach?"), true);
// genuine question with the option list AFTER it (trailing list items peeled)
assert.strictEqual(Q("Pick one?\n1. Subagent-Driven\n2. Inline Execution"), true);

// lastAssistantText pulls the newest assistant text block
const tail = [
  JSON.stringify({ type: "user", message: { content: "hi" } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "older" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Which file did you mean?" }] } }),
].join("\n");
assert.strictEqual(A.lastAssistantText(tail), "Which file did you mean?");
assert.strictEqual(Q(A.lastAssistantText(tail)), true);

// awaitsUser: a turn needs you if it's a genuine question OR an approval /
// go-ahead request (which carries no '?' at all).
const AW = A.awaitsUser;
// questions still flow through
assert.strictEqual(AW("Which approach?"), true);
// approval / go-ahead requests, no '?'
assert.strictEqual(AW("If you're good with this framing, say go and I'll snapshot the state."), true);
assert.strictEqual(AW("Give me the green light and I'll deploy."), true);
assert.strictEqual(AW("Ready when you are."), true);
assert.strictEqual(AW("Standing by for your go-ahead."), true);
assert.strictEqual(AW("Approve and I'll write it up."), true);
// directive "let me know" -> needs you; bare courtesy -> not
assert.strictEqual(AW("Let me know which approach you prefer."), true);
assert.strictEqual(AW("Done. All tests pass. Let me know if you hit any issues."), false);
// no ask at all / rhetorical / narrated "green light"
assert.strictEqual(AW("Done. All tests pass."), false);
assert.strictEqual(AW("How does it work? Like this: we do X then Y."), false);
assert.strictEqual(AW("The project finally got the green light last quarter."), false);
// a scoped-work turn: "say go" buried before a list + parked-item note
const mc = "My recommended scope for Friday: the audit check + summary view. " +
  "If you're good with this framing, say go and I'll: snapshot the item list, run the " +
  "audit check, build the edit feature, and draft the summary view. One parked item " +
  "so it's not lost: the git-init decision is still open. Happy to leave it until after, just flagging it.";
assert.strictEqual(AW(mc), true);
// directive questions: a second-person ask ("want me to…?", "should I…?")
// buried mid-paragraph still needs you, even when a courtesy statement follows
// the '?'. Rhetorical questions without a directive phrase stay untouched.
// THE BUG (2026-07-06): question followed by a trailing statement sentence
const sheets = "Let me reset to the simple path — no rm, no Python-driving-gws, no chunk juggling:\n\n" +
  "1. Write the sheet values to a single JSON file (plain file write).\n" +
  "2. Populate each tab with one gws sheets spreadsheets values update call reading that file from bash.\n" +
  "3. One gws ... batchUpdate for the per-parent grouping.\n\n" +
  "The spreadsheet already exists here (empty): https://docs.google.com/spreadsheets/d/EXAMPLE_SHEET_ID_0000000000\n\n" +
  "Before I run anything else: want me to proceed with that simple 3-step fill, or would you rather " +
  "I just hand you the data as a CSV you drop into the sheet yourself? Either is quick — I just " +
  "don't want to keep firing commands that make you babysit prompts.";
assert.strictEqual(AW(sheets), true);
assert.strictEqual(A.awaitReason(sheets), "typed a question");
// more directive phrasings with trailing courtesy statements
assert.strictEqual(AW("Should I ship it now, or wait for the review? No rush either way."), true);
assert.strictEqual(AW("Shall I go ahead with the merge? The branch is green."), true);
assert.strictEqual(AW("Would you prefer the compact layout? Both render fine on mobile."), true);
assert.strictEqual(AW("Do you want me to keep the old file around? It costs nothing to keep."), true);
// rhetorical '?' with no directive phrase must NOT flip
assert.strictEqual(AW("How does caching help? Every lookup after the first is free. Moving on to the tests."), false);
// directive question in an EARLIER paragraph, later paragraph is pure work -> not waiting now
assert.strictEqual(AW("Want me to also refactor the helpers?\n\nFor now I'm continuing with the main task: rewriting the parser."), false);
// URL query-string '?' is not a question
assert.strictEqual(AW("Deployed. Live at https://example.com/page?tab=2&x=1 and the logs are clean."), false);
// THE BUG (2026-07-09): approval-question phrasings + trailing conditional statement.
// A real approval turn: "Good to proceed this way? If yes, I'll start ..." — this
// slipped past all three detectors (not "want me to…", "?" not line-final).
const proceed = "Given the stakes, here is the careful sequence:\n\n" +
  "1. Pause the 3 scheduled tasks while I work.\n" +
  "2. Tag the current main first.\n\n" +
  "Good to proceed this way? If yes, I'll start with steps 1-2 (pause tasks + tag) right away.";
assert.strictEqual(AW(proceed), true);
assert.strictEqual(A.awaitReason(proceed), "typed a question");
// sibling approval-question phrasings (Agent View reports all as idle)
assert.strictEqual(AW("OK to proceed this way? I'll begin once you confirm."), true);
assert.strictEqual(AW("Shall we proceed? The plan is ready."), true);
// conditional-on-approval trailing statement is itself a go-ahead ask
assert.strictEqual(AW("Here's the plan. If yes, I'll start right away."), true);
// regressions: these must STAY quiet
assert.strictEqual(AW("The migration will proceed automatically once merged."), false); // "proceed" but no question to user
assert.strictEqual(AW("If yes is the answer the test passes; if no it fails."), false);  // "if yes" not paired with "I'll"

// awaitReason drives an accurate subtitle
assert.strictEqual(A.awaitReason("Which approach?"), "typed a question");
assert.strictEqual(A.awaitReason("Say go and I'll start."), "awaiting your reply");
assert.strictEqual(A.awaitReason("Done."), null);

// --- "you are here": resolve the focused terminal back to its session -------
// A terminal's shell process is an ancestor of the session process running in
// it, so we walk the pid -> ppid map upward from each session until we hit the
// terminal's pid. pmap below models two terminals:
//   shell 100 -> node 200 -> claude 300   |   shell 500 -> claude 600
const pmap = new Map([[100, 1], [200, 100], [300, 200], [500, 1], [600, 500]]);
const sessFix = [{ sid: "s1", pid: 300 }, { sid: "s2", pid: 600 }];
assert.strictEqual(A.sessionForTerminal(sessFix, 100, pmap), "s1");
assert.strictEqual(A.sessionForTerminal(sessFix, 500, pmap), "s2");
// raw supervisor records (sessionId, not sid) resolve the same way
assert.strictEqual(A.sessionForTerminal([{ sessionId: "r1", pid: 300 }], 100, pmap), "r1");
// mark nothing rather than the wrong card when we can't resolve
assert.strictEqual(A.sessionForTerminal(sessFix, 999, pmap), null);       // terminal we don't know
assert.strictEqual(A.sessionForTerminal(sessFix, 0, pmap), null);         // no active terminal
assert.strictEqual(A.sessionForTerminal(sessFix, 100, new Map()), null);  // no process map
assert.strictEqual(A.sessionForTerminal([], 100, pmap), null);
assert.strictEqual(A.sessionForTerminal([{ sid: "x" }], 100, pmap), null); // session with no pid

// ancestorsOf walks to the root and is cycle-safe
assert.deepStrictEqual([...A.ancestorsOf(300, pmap)], [300, 200, 100]);
assert.deepStrictEqual([...A.ancestorsOf(0, pmap)], []);
assert.deepStrictEqual([...A.ancestorsOf(7, new Map([[7, 8], [8, 7]]))], [7, 8]);

// --- formatters (Task 1) ---
assert.strictEqual(A.shortModel("claude-opus-4-8"), "opus-4-8");
assert.strictEqual(A.shortModel("fable-5"), "fable-5");   // no prefix -> passthrough
assert.strictEqual(A.shortModel(""), "");
assert.strictEqual(A.fmtTokens(137216), "137k");
assert.strictEqual(A.fmtTokens(950), "950");
assert.strictEqual(A.fmtTokens(0), "");
assert.strictEqual(A.fmtDuration(41000), "41s");
assert.strictEqual(A.fmtDuration(180000), "3m");
assert.strictEqual(A.fmtDuration(13500000), "3h45m");
assert.strictEqual(A.ctxPct(137216), 69);      // /200k
assert.strictEqual(A.ctxPct(268000), 27);      // >200k -> /1M
assert.strictEqual(A.ctxPct(0), null);
assert.strictEqual(A.jumpLabel("needs"), "Answer now");
assert.strictEqual(A.jumpLabel("working"), "Watch / interrupt");
assert.strictEqual(A.jumpLabel("idle"), "Continue");
assert.strictEqual(A.jumpLabel("done"), "Continue");

// --- toSession metadata + metaLine (Task 2) ---
const s2 = A.toSession(
  { sessionId: "m1", status: "busy", cwd: "C:/x/proj" },
  { nowMs: 100000, statusSinceMs: 59000, startedAtMs: 100000 - 13500000,
    model: "claude-fable-5", ctxTokens: 268000 });
assert.strictEqual(s2.jumpLabel, "Watch / interrupt");
assert.strictEqual(s2.model, "fable-5");
assert.strictEqual(s2.ctxTokens, 268000);
assert.strictEqual(s2.ctxPct, 27);
assert.strictEqual(s2.sinceMs, 41000);
assert.strictEqual(s2.uptimeMs, 13500000);
assert.strictEqual(A.metaLine(s2), "working 41s · fable-5 · ctx 268k · 27% · up 3h45m");

// needs-state keeps its reason as the head bit; missing meta degrades cleanly
const s3 = A.toSession({ sessionId: "m2", status: "waiting", waitingFor: "typed a question" },
  { nowMs: 5000, statusSinceMs: 5000 });
assert.strictEqual(A.metaLine(s3), "needs you · typed a question");

// ==== suite contributed by DS (fork 2.7.1) — feed, telemetry, formatting ====
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("truncate leaves short strings alone", () => {
  assert.strictEqual(A.truncate("hello", 10), "hello");
});
test("truncate cuts long strings with ellipsis", () => {
  assert.strictEqual(A.truncate("abcdefghij", 5), "abcd…");
});
test("firstLine returns first non-empty trimmed line", () => {
  assert.strictEqual(A.firstLine("\n  npm test \n more"), "npm test");
});
test("summarizeTool Bash shows first command line", () => {
  assert.strictEqual(A.summarizeTool("Bash", { command: "npm test\n--verbose" }), "Bash: npm test");
});
test("summarizeTool Read shows basename", () => {
  assert.strictEqual(A.summarizeTool("Read", { file_path: "/a/b/extension.js" }), "Read: extension.js");
});
test("summarizeTool Edit shows basename", () => {
  assert.strictEqual(A.summarizeTool("Edit", { file_path: "/a/b/agents.js" }), "Edit: agents.js");
});
test("summarizeTool Grep shows pattern", () => {
  assert.strictEqual(A.summarizeTool("Grep", { pattern: "foo.*bar" }), "Grep: foo.*bar");
});
test("summarizeTool Task shows description", () => {
  assert.strictEqual(A.summarizeTool("Task", { description: "explore repo" }), "Task: explore repo");
});
test("summarizeTool Agent renders as Task label", () => {
  assert.strictEqual(A.summarizeTool("Agent", { description: "explore repo" }), "Task: explore repo");
});
test("summarizeTool unknown tool shows bare name", () => {
  assert.strictEqual(A.summarizeTool("Weird", {}), "Weird");
});
test("summarizeTool missing field falls back to bare name", () => {
  assert.strictEqual(A.summarizeTool("Bash", {}), "Bash");
});
test("iconForTool maps families", () => {
  assert.strictEqual(A.iconForTool("Read"), "📖");
  assert.strictEqual(A.iconForTool("Bash"), "🔧");
  assert.strictEqual(A.iconForTool("WebFetch"), "🌐");
});

// Task 3: splitTail and recentEvents
const mkText = (ts, s) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text: s }] } });
const mkTool = (ts, id, name, input) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name, input }] } });
const mkResult = (ts, id, isError) => JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !!isError }] } });

test("splitTail drops leading fragment when hadOffset", () => {
  assert.deepStrictEqual(A.splitTail("frag}\n{\"a\":1}\n", true), ["{\"a\":1}"]);
});
test("splitTail keeps first line when no offset", () => {
  assert.deepStrictEqual(A.splitTail("{\"a\":1}\n{\"b\":2}\n", false), ["{\"a\":1}", "{\"b\":2}"]);
});
test("recentEvents returns newest-last, capped at n", () => {
  const lines = [mkText("t1", "first"), mkText("t2", "second"), mkText("t3", "third")];
  const ev = A.recentEvents(lines, 2);
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[0].text, "second");
  assert.strictEqual(ev[1].text, "third");
  assert.strictEqual(ev[1].kind, "text");
});
test("recentEvents folds tool_result ok by tool_use_id", () => {
  const lines = [mkTool("t1", "abc", "Bash", { command: "ls" }), mkResult("t2", "abc", false)];
  const ev = A.recentEvents(lines, 5);
  const tool = ev.find(e => e.kind === "tool");
  assert.strictEqual(tool.ok, true);
  assert.strictEqual(tool.text, "Bash: ls");
});
test("recentEvents marks error result ok=false", () => {
  const lines = [mkTool("t1", "abc", "Bash", { command: "ls" }), mkResult("t2", "abc", true)];
  const tool = A.recentEvents(lines, 5).find(e => e.kind === "tool");
  assert.strictEqual(tool.ok, false);
});
test("recentEvents leaves ok undefined when result missing (truncated)", () => {
  const lines = [mkTool("t1", "abc", "Bash", { command: "ls" })];
  const tool = A.recentEvents(lines, 5).find(e => e.kind === "tool");
  assert.strictEqual(tool.ok, undefined);
});
test("recentEvents folds correct ids with parallel tool calls", () => {
  const twoTools = JSON.stringify({ type: "assistant", timestamp: "t1", message: { content: [
    { type: "tool_use", id: "id1", name: "Read", input: { file_path: "a.js" } },
    { type: "tool_use", id: "id2", name: "Bash", input: { command: "ls" } },
  ] } });
  const twoResults = JSON.stringify({ type: "user", timestamp: "t2", message: { content: [
    { type: "tool_result", tool_use_id: "id2", is_error: true },
    { type: "tool_result", tool_use_id: "id1", is_error: false },
  ] } });
  const ev = A.recentEvents([twoTools, twoResults], 5);
  const read = ev.find(e => e.text === "Read: a.js");
  const bash = ev.find(e => e.text === "Bash: ls");
  assert.strictEqual(read.ok, true);
  assert.strictEqual(bash.ok, false);
});
test("recentEvents skips a giant line but keeps neighbors", () => {
  const giant = JSON.stringify({ type: "user", timestamp: "t2", message: { content: [{ type: "tool_result", tool_use_id: "x", text: "Z".repeat(40 * 1024) }] } });
  const lines = [mkText("t1", "before"), giant];
  const ev = A.recentEvents(lines, 5);
  assert.ok(ev.some(e => e.text === "before"));
  assert.ok(!ev.some(e => e.text && e.text.includes("ZZZ")));
});
test("recentEvents emits one placeholder when only unrenderable content exists", () => {
  const giant = "Z".repeat(40 * 1024);
  const ev = A.recentEvents([giant], 5);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, "system");
  assert.strictEqual(ev[0].icon, "⋯");
});
test("recentEvents returns empty for no content at all", () => {
  assert.deepStrictEqual(A.recentEvents(["", "   "], 5), []);
});
test("recentEvents skips malformed json lines", () => {
  const ev = A.recentEvents(["not json", mkText("t1", "ok")], 5);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].text, "ok");
});

// Task 4: pickMidEvent and line-based lastAssistantText
test("pickMidEvent prefers newest text/tool over thinking", () => {
  const events = [
    { kind: "thinking", text: "thinking…" },
    { kind: "tool", text: "Read: a.js" },
    { kind: "thinking", text: "thinking…" },
  ];
  assert.strictEqual(A.pickMidEvent(events).text, "Read: a.js");
});
test("pickMidEvent falls back to thinking when nothing better", () => {
  const events = [{ kind: "thinking", text: "thinking…" }];
  assert.strictEqual(A.pickMidEvent(events).kind, "thinking");
});
test("pickMidEvent returns null for empty", () => {
  assert.strictEqual(A.pickMidEvent([]), null);
});
test("lastAssistantTextFromLines returns last assistant text", () => {
  const lines = [mkText("t1", "older"), mkTool("t2", "id", "Bash", { command: "ls" }), mkText("t3", "newest text")];
  assert.strictEqual(A.lastAssistantTextFromLines(lines), "newest text");
});
test("lastAssistantText string API still works", () => {
  const tail = mkText("t1", "hello?") + "\n";
  assert.strictEqual(A.lastAssistantText(tail), "hello?");
  assert.strictEqual(A.endsWithQuestion(A.lastAssistantText(tail)), true);
});

test("lastLine returns the last non-empty line", () => {
  assert.strictEqual(A.lastLine("Thursday, July 2, 2026\n\nPick a number/letter"), "Pick a number/letter");
  assert.strictEqual(A.lastLine("  single  "), "single");
});
test("recentEvents text event shows the operative LAST line of a message", () => {
  const menu = mkText("t1", "Thursday, July 2, 2026\n\nWhat would you like to do?\n\nPick a number/letter, name a project, or just tell me what you want to do.");
  const ev = A.recentEvents([menu], 5);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, "text");
  assert.ok(ev[0].text.startsWith("Pick a number/letter"), "expected last line, got: " + ev[0].text);
});

test("recentEvents carries full untruncated content for the hover tooltip", () => {
  const longCmd = "echo " + "x".repeat(200);
  const lines = [
    mkText("t1", "Line one\n\nThe operative last line."),
    mkTool("t2", "id", "Bash", { command: longCmd }),
  ];
  const ev = A.recentEvents(lines, 5);
  const text = ev.find(e => e.kind === "text");
  const tool = ev.find(e => e.kind === "tool");
  // display text is truncated / last-line; full has the whole block / whole command
  assert.ok(text.full.includes("Line one") && text.full.includes("operative last line"));
  assert.ok(tool.full.length > tool.text.length);
  assert.ok(tool.full.includes("x".repeat(200)));
});
test("summarizeTool full=true returns untruncated label", () => {
  const cmd = "npm test " + "y".repeat(120);
  assert.strictEqual(A.summarizeTool("Bash", { command: cmd }, true), "Bash: " + cmd);
  assert.strictEqual(A.summarizeTool("Read", { file_path: "/a/b/c/extension.js" }, true), "Read: /a/b/c/extension.js");
});

// ---- telemetry: toMs ----
const t = test;   // shorthand for the telemetry block
t("toMs parses ISO string", () => assert(A.toMs("2026-07-06T17:31:31.036Z") === Date.parse("2026-07-06T17:31:31.036Z")));
t("toMs passes through finite numbers", () => assert(A.toMs(1783354359217) === 1783354359217));
t("toMs rejects garbage", () => assert(A.toMs("nope") === null && A.toMs(undefined) === null && A.toMs(NaN) === null && A.toMs(null) === null));

// ---- telemetry: telemetryFromLines ----
const TL = (o) => JSON.stringify(o);
const tlLines = [
  TL({ type: "user", timestamp: "2026-07-06T10:00:00Z", message: { content: "do the thing" } }),
  TL({ type: "assistant", timestamp: "2026-07-06T10:00:10Z", message: { model: "claude-fable-5", usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, content: [ { type: "tool_use", id: "tu1", name: "Task", input: { description: "sub A" } }, { type: "tool_use", id: "tu2", name: "Agent", input: {} } ] } }),
  TL({ type: "user", timestamp: "2026-07-06T10:00:20Z", message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } }),
  TL({ type: "user", timestamp: "2026-07-06T10:00:30Z", isMeta: true, message: { content: "meta noise" } }),
];
t("telemetry: model from last assistant", () => assert(A.telemetryFromLines(tlLines).model === "claude-fable-5"));
t("telemetry: ctxTokens sums usage", () => assert(A.telemetryFromLines(tlLines).ctxTokens === 1150));
t("telemetry: lastUserTs skips tool_result and isMeta user lines", () =>
  assert(A.telemetryFromLines(tlLines).lastUserTs === Date.parse("2026-07-06T10:00:00Z")));
t("telemetry: lastAssistantTs", () => assert(A.telemetryFromLines(tlLines).lastAssistantTs === Date.parse("2026-07-06T10:00:10Z")));
t("telemetry: agentsRunning counts unmatched Task/Agent tool_use", () => assert(A.telemetryFromLines(tlLines).agentsRunning === 1));
t("telemetry: all absent on empty/garbage", () => {
  const r = A.telemetryFromLines(["not json", ""]);
  assert(r.model === null && r.ctxTokens === null && r.lastUserTs === null && r.lastAssistantTs === null && r.agentsRunning === 0);
});
t("telemetry: user line with text blocks counts as real prompt", () => {
  const r = A.telemetryFromLines([TL({ type: "user", timestamp: "2026-07-06T11:00:00Z", message: { content: [{ type: "text", text: "hi" }] } })]);
  assert(r.lastUserTs === Date.parse("2026-07-06T11:00:00Z"));
});
t("telemetry: giant tool_result line skipped -> agent counts as running (transient, accepted)", () => {
  const giant = TL({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu9" }] }, pad: "x".repeat(40 * 1024) });
  const r = A.telemetryFromLines([
    TL({ type: "assistant", timestamp: "2026-07-06T10:00:00Z", message: { content: [{ type: "tool_use", id: "tu9", name: "Task", input: {} }] } }),
    giant,
  ]);
  assert(r.agentsRunning === 1);
});

// ---- telemetry: formatting ----
t("modelBadge shortens known ids", () => {
  assert(A.modelBadge("claude-fable-5") === "fable-5");
  assert(A.modelBadge("claude-opus-4-8") === "opus-4.8");
  assert(A.modelBadge("claude-haiku-4-5-20251001") === "haiku-4.5");
  assert(A.modelBadge("claude-sonnet-5") === "sonnet-5");
  assert(A.modelBadge(null) === null);
});
t("fmtElapsed buckets", () => {
  assert(A.fmtElapsed(5000) === "5s");
  assert(A.fmtElapsed(4 * 60000) === "4m");
  assert(A.fmtElapsed((3 * 60 + 12) * 60000) === "3h12m");
  assert(A.fmtElapsed(null) === null && A.fmtElapsed(-5) === "0s");
});
const NOW = Date.parse("2026-07-06T12:00:00Z");
const sess = (state, extra) => Object.assign({ state, sub: state === "needs" ? "needs you" : state, startedAt: null, waitingFor: null }, extra || {});
const tele = (extra) => Object.assign({ lastUserTs: null, lastAssistantTs: null, model: null, ctxTokens: null, agentsRunning: 0 }, extra || {});
t("statusText: working elapsed from lastUserTs + badge + agents", () => {
  const r = A.telemetryText(sess("working"), tele({ lastUserTs: NOW - 4 * 60000, model: "claude-fable-5", agentsRunning: 2 }), NOW);
  assert.strictEqual(r.statusText, "working 4m · 2 agents");
  assert.strictEqual(r.metaText, "fable-5");
  const one = A.telemetryText(sess("working"), tele({ lastUserTs: NOW - 60000, agentsRunning: 1 }), NOW);
  assert.strictEqual(one.statusText, "working 1m · 1 agent");
});
t("statusText: needs elapsed from lastAssistantTs, keeps waitingFor", () => {
  const r = A.telemetryText(sess("needs", { waitingFor: "permission prompt" }), tele({ lastAssistantTs: NOW - 12 * 60000, model: "claude-opus-4-8" }), NOW);
  assert.strictEqual(r.statusText, "needs you 12m · permission prompt");
  assert.strictEqual(r.metaText, "opus-4.8");
});
t("statusText: no telemetry falls back to sub verbatim", () => {
  const r = A.telemetryText(sess("idle", { sub: "idle" }), null, NOW);
  assert(r.statusText === "idle" && r.metaText === null && r.tooltipLines.length === 0);
});
t("statusText: segments without elapsed still lead with state word", () => {
  const r = A.telemetryText(sess("working"), tele({ model: "claude-fable-5" }), NOW);
  assert.strictEqual(r.statusText, "working");
  assert.strictEqual(r.metaText, "fable-5");
});
t("metaText: ctx% + uptime; over-window shows real used amount", () => {
  const r = A.telemetryText(sess("working", { startedAt: NOW - (3 * 60 + 12) * 60000 }), tele({ ctxTokens: 124000 }), NOW);
  assert.strictEqual(r.metaText, "ctx 62% · up 3h12m");
  const c = A.telemetryText(sess("working"), tele({ ctxTokens: 247000 }), NOW);
  assert.strictEqual(c.metaText, "ctx 247k");
  const tt = A.telemetryText(sess("working"), tele({ ctxTokens: 247000 }), NOW);
  assert(tt.tooltipLines.some((l) => l === "context: 247k tokens used"));
});
t("metaText: uptime alone works without transcript", () => {
  const r = A.telemetryText(sess("idle", { startedAt: NOW - 60000 }), null, NOW);
  assert.strictEqual(r.metaText, "up 1m");
});
t("tooltipLines include dir when cwd known", () => {
  const r = A.telemetryText(sess("working", { cwd: "/Users/x/proj" }), tele({ model: "claude-fable-5" }), NOW);
  assert(r.tooltipLines.some((l) => l === "dir: /Users/x/proj"));
});
t("tooltipLines are static (model id, tokens, agents, started)", () => {
  const r = A.telemetryText(sess("working", { startedAt: NOW - 1000 }), tele({ model: "claude-fable-5", ctxTokens: 124000, agentsRunning: 1 }), NOW);
  assert(r.tooltipLines.some((l) => l.includes("claude-fable-5")));
  assert(r.tooltipLines.some((l) => l.includes("124k/200k")));
  assert(r.tooltipLines.some((l) => l.includes("subagents: 1")));
  assert(r.tooltipLines.some((l) => l.startsWith("started: ")));
  assert(!r.tooltipLines.some((l) => l.includes("up ")));   // no ticking uptime in tooltip
});
t("toSession carries startedAt and waitingFor", () => {
  const s = A.toSession({ sessionId: "x", status: "waiting", waitingFor: "permission prompt", startedAt: 1783354359217, cwd: "/a/b" });
  assert(s.startedAt === 1783354359217 && s.waitingFor === "permission prompt");
  const s2 = A.toSession({ sessionId: "y", status: "busy", cwd: "/a/b" });
  assert(s2.startedAt === null && s2.waitingFor === null);
});

// ---- needs-you detection (ported from upstream 2.0.5) ----
t("isUserQuestion: plain trailing question", () => assert(A.isUserQuestion("Pick one.\nWhich approach do you prefer?") === true));
t("isUserQuestion: skips trailing option list without ?", () => {
  const text = "Which approach should I take?\n1. Fast and dirty\n2. Slow and careful\n- both have tradeoffs";
  assert(A.isUserQuestion(text) === true);
});
t("isUserQuestion: peels trailing parenthetical", () =>
  assert(A.isUserQuestion("Which approach? (or say pause and I'll wait)") === true));
t("isUserQuestion: statement is not a question", () =>
  assert(A.isUserQuestion("Done. All tests pass.") === false));
t("asksApproval: go-ahead phrasings", () => {
  assert(A.asksApproval("Ready when you are.") === true);
  assert(A.asksApproval("Give me the green light and I'll ship it.") === true);
  assert(A.asksApproval("Let me know which option you prefer.") === true);
  assert(A.asksApproval("If you're happy with this plan, I'll start.") === true);
});
t("asksApproval: plain statements do not match", () => {
  assert(A.asksApproval("I finished the refactor and pushed.") === false);
  assert(A.asksApproval("") === false);
});
t("asksApproval: generic completion closers do NOT match", () => {
  assert(A.asksApproval("Done. All tests pass. Let me know if you'd like anything else.") === false);
  assert(A.asksApproval("Let me know if you'd like any changes.") === false);
  assert(A.asksApproval("Let me know which option you prefer.") === true);   // real directive still matches
});
t("awaitReason: labels question vs approval vs none", () => {
  assert.strictEqual(A.awaitReason("What should I do next?"), "typed a question");
  assert.strictEqual(A.awaitReason("Let me know which option you prefer."), "awaiting your reply");
  assert.strictEqual(A.awaitReason("All done."), null);
});

// ---- telemetry: sticky lastUserTs merge ----
t("mergeTelemetry carries lastUserTs forward when window lost it", () => {
  const prev = tele({ lastUserTs: 111 });
  const cur = tele({ model: "claude-fable-5" });
  const m = A.mergeTelemetry(prev, cur);
  assert(m.lastUserTs === 111 && m.model === "claude-fable-5");
});
t("mergeTelemetry: fresh lastUserTs wins; no prev passes through", () => {
  assert(A.mergeTelemetry(tele({ lastUserTs: 111 }), tele({ lastUserTs: 222 })).lastUserTs === 222);
  assert(A.mergeTelemetry(null, tele({ lastUserTs: 5 })).lastUserTs === 5);
  assert(A.mergeTelemetry(undefined, null) === null);
});

// ==== 3.1: artifact-strip — quoted/fenced/drafted text is MENTION, not USE ====
// The real-world false positive (2026-07-10): a long answer PRESENTING a draft
// reply whose body contained approval phrasing lit the card red for 6 hours.
t("strip: approval phrase inside a ---draft--- block does not flag", () => {
  const msg = "Here is a draft reply for his thread. Review it and send it yourself:\n\n" +
    "---\n\nHi, the merge is done. If anything feels wrong, tell me. " +
    "Say the word and I will publish it right away.\n\n---\n\n" +
    "All sending stays in your hands.";
  assert.strictEqual(AW(msg), false);
});
t("strip: approval phrase inside double quotes does not flag", () => {
  assert.strictEqual(AW('The old closer was "ready when you are." We removed it yesterday.'), false);
  assert.strictEqual(AW('It answers the question: "which of my sessions is waiting for me?" Nothing else changed.'), false);
});
t("strip: approval phrase inside a code fence does not flag", () => {
  assert.strictEqual(AW("The test asserts this stays quiet:\n```\nsay go and I'll start\n```\nAll green."), false);
});
t("strip: directive question inside quotes does not flag", () => {
  assert.strictEqual(AW('His draft asked "want me to proceed with the fill?" but we cut that sentence. Done.'), false);
});
// genuine asks are NEVER inside artifacts — they must all still fire:
t("strip regression: genuine mid-message say-go still flags", () => {
  assert.strictEqual(AW(mc), true);                       // the guarded 2.0.5 case
});
t("strip regression: genuine ask CONTAINING a quoted word still flags", () => {
  assert.strictEqual(AW('Should I name the setting "smart" or keep "fast"? Both work.'), true);
  assert.strictEqual(AW("If you're happy with this plan, I'll rename the setting."), true);
});
t("strip regression: plain approval closers still flag", () => {
  assert.strictEqual(AW("Ready when you are."), true);
  assert.strictEqual(AW("Say the word and I'll publish."), true);
});

// ==== F1/F2 helpers (3.0.0) ====
// F2 busyAwaitReason: BOTH conditions (stale transcript AND awaiting text) required.
const T0 = 10_000_000;
t("F2: busy + stale + question -> flags", () =>
  assert.strictEqual(A.busyAwaitReason("Should I ship it?", T0 - 3 * 60000, T0), "typed a question"));
t("F2: busy + stale + approval ask -> flags", () =>
  assert.strictEqual(A.busyAwaitReason("Say go and I'll start.", T0 - 3 * 60000, T0), "awaiting your reply"));
t("F2 NEGATIVE: busy + FRESH transcript + question -> stays working", () =>
  assert.strictEqual(A.busyAwaitReason("Should I ship it?", T0 - 30000, T0), null));
t("F2 NEGATIVE: busy + stale + NON-question -> stays working", () =>
  assert.strictEqual(A.busyAwaitReason("Running the migration now.", T0 - 60 * 60000, T0), null));
t("F2 NEGATIVE: missing mtime -> never flags", () =>
  assert.strictEqual(A.busyAwaitReason("Should I ship it?", null, T0), null));
t("F2: custom threshold respected", () => {
  assert.strictEqual(A.busyAwaitReason("Ship it?", T0 - 5000, T0, 4000), "typed a question");
  assert.strictEqual(A.busyAwaitReason("Ship it?", T0 - 3000, T0, 4000), null);
});

// F1 pollFailureAction: grace window, cold start, hard error.
t("F1: 1st/2nd failure with last-good board -> repost it", () => {
  assert.strictEqual(A.pollFailureAction(1, true), "repost");
  assert.strictEqual(A.pollFailureAction(2, true), "repost");
});
t("F1: cold start (no last-good) -> wait, keep placeholder", () => {
  assert.strictEqual(A.pollFailureAction(1, false), "wait");
  assert.strictEqual(A.pollFailureAction(2, false), "wait");
});
t("F1: 3rd consecutive failure -> surface the error", () => {
  assert.strictEqual(A.pollFailureAction(3, true), "error");
  assert.strictEqual(A.pollFailureAction(3, false), "error");
  assert.strictEqual(A.pollFailureAction(7, true), "error");
});

console.log(`\n${passed} passed`);

console.log("PASS — all agents.js unit tests green");
