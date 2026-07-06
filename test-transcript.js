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
console.log("transcript tests passed");
