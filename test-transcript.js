// Unit tests for transcript.js — run with: node test-transcript.js
const assert = require("assert");
const T = require("./transcript");

const jsonl = [
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "text", text: "Editing the file now." },
    { type: "tool_use", name: "Edit", input: { file_path: "C:/x/tests/t.py" } },
  ] } }),
  JSON.stringify({ type: "user", toolUseResult: { structuredPatch: [
    { oldStart: 56, oldLines: 5, newStart: 56, newLines: 5, lines: [
      "     e = 1", "-    old_a", "-    old_b", "+    new_a", "+    new_b", "     f = 2" ] },
  ] } }),
  "{ broken json",   // must be skipped, not thrown
].join("\n");

const events = T.parse(jsonl);
assert.strictEqual(events.length, 3);
assert.deepStrictEqual(events[0], { kind: "text", text: "Editing the file now." });
assert.deepStrictEqual(events[1], { kind: "tool", tool: "Edit", arg: "C:/x/tests/t.py" });
assert.strictEqual(events[2].kind, "diff");
assert.strictEqual(events[2].added, 2);
assert.strictEqual(events[2].removed, 2);
// line contents preserved with sign stripped
const ls = events[2].hunks[0].lines;
assert.deepStrictEqual(ls[0], { sign: " ", text: "    e = 1" });
assert.deepStrictEqual(ls[1], { sign: "-", text: "    old_a" });
assert.deepStrictEqual(ls[3], { sign: "+", text: "    new_a" });

// renderHtml: escapes, marks add/del, shows real line numbers, honors truncated note.
// Numbering for this hunk (oldStart=newStart=56): ctx 56, del 57, del 58 (old side);
// add 57, add 58 (new side); ctx 59. So both 56 and 59 are context bounds.
const html = T.renderHtml(events, { truncatedNote: true });
assert.ok(html.includes("earlier history hidden"));
assert.ok(html.includes("Update(C:/x/tests/t.py)"));   // Edit renders as Update(...)
assert.ok(html.includes("Added 2 lines, removed 2 lines"));
assert.ok(html.includes('class="ov-line del"'));
assert.ok(html.includes('class="ov-line add"'));
assert.ok(html.includes(">56</span>"));   // first context line, old #56
assert.ok(html.includes(">57</span>"));   // first removed line, old #57
assert.ok(html.includes(">59</span>"));   // last context line, old #59
assert.strictEqual(T.esc("<a>&"), "&lt;a&gt;&amp;");

// --- readTail (Task 4) ---
const tail = [
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8",
    usage: { input_tokens: 2, cache_read_input_tokens: 136578, cache_creation_input_tokens: 636 },
    content: [ { type: "tool_use", name: "Bash", input: { command: "node test.js" } } ] } }),
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8",
    usage: { input_tokens: 5, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 },
    content: [ { type: "tool_use", name: "Edit", input: { file_path: "C:/x/foo/bar.py" } },
               { type: "text", text: "Done. Want me to ship it?" } ] } }),
].join("\n");
const meta = T.readTail(tail, (t) => (/\?\s*$/.test(t) ? "typed a question" : null));
assert.strictEqual(meta.model, "claude-opus-4-8");
assert.strictEqual(meta.ctxTokens, 200005);          // last message's usage sum (5+200000+0)
assert.strictEqual(meta.awaitReason, "typed a question");
assert.deepStrictEqual(meta.activity, ["Bash: node test.js", "Edit: bar.py"]);
assert.strictEqual(meta.lastMsg, "Done. Want me to ship it?");   // latest assistant text surfaces on the card
assert.ok(T.readTail("", null).model === "");        // empty is safe
assert.strictEqual(T.readTail("", null).lastMsg, "");

// lastMsg is compacted to its first line, capped at 80 chars
const longMsg = JSON.stringify({ type: "assistant", message: { content: [
  { type: "text", text: "x".repeat(100) + "\nsecond line" } ] } });
assert.strictEqual(T.readTail(longMsg, null).lastMsg, "x".repeat(79) + "…");

// activity keeps the last 7 entries (expanded card shows 6-7 lines)
const nine = JSON.stringify({ type: "assistant", message: { content:
  [1,2,3,4,5,6,7,8,9].map(i => ({ type: "tool_use", name: "Edit", input: { file_path: "f" + i + ".py" } })) } });
assert.deepStrictEqual(T.readTail(nine, null).activity,
  ["Edit: f3.py", "Edit: f4.py", "Edit: f5.py", "Edit: f6.py", "Edit: f7.py", "Edit: f8.py", "Edit: f9.py"]);

// tool with no file/command renders without empty parens
const noArg = T.parse(JSON.stringify({ type: "assistant", message: { content: [
  { type: "tool_use", name: "TaskCreate", input: {} } ] } }));
assert.ok(T.renderHtml(noArg).includes("• TaskCreate<"));    // "• TaskCreate</div>", no ()
assert.ok(!T.renderHtml(noArg).includes("TaskCreate()"));

// Bash activity is trimmed to a compact first line
const multi = JSON.stringify({ type: "assistant", message: { content: [
  { type: "tool_use", name: "Bash", input: { command: "echo hi\nsecond line\nthird line" } } ] } });
assert.deepStrictEqual(T.readTail(multi, null).activity, ["Bash: echo hi"]);

console.log("transcript tests passed");
