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
// the real scoped-work turn: "say go" buried before a list + parked-item note
const mc = "My recommended scope for Friday: audit check + summary view. " +
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
// The exact approval turn: "Good to proceed this way? If yes, I'll start ..." — this
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

console.log("PASS — all agents.js unit tests green");
