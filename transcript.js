// Pure transcript parsing/rendering for Overlord's viewer. No VS Code deps, no fs —
// callers pass in JSONL text. Stateless per line so the same parse() handles a full
// file or an appended tail.
"use strict";

// Claude Code tool names -> the verb the CLI shows in a transcript header.
const VERB = { Edit: "Update", MultiEdit: "Update", Write: "Write", Read: "Read",
  Bash: "Bash", Grep: "Grep", Glob: "Glob", NotebookEdit: "Update" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toolArg(b) {
  const inp = b.input || {};
  if (inp.file_path) return inp.file_path;
  if (typeof inp.command === "string") return inp.command;
  if (typeof inp.pattern === "string") return inp.pattern;
  return "";
}

function toDiff(structuredPatch) {
  let added = 0, removed = 0;
  const hunks = [];
  for (const h of structuredPatch) {
    if (!h || !Array.isArray(h.lines) || !h.lines.length) continue;
    const lines = [];
    for (const raw of h.lines) {
      const c = String(raw)[0];
      const sign = c === "+" ? "+" : c === "-" ? "-" : " ";
      if (sign === "+") added++; else if (sign === "-") removed++;
      lines.push({ sign, text: String(raw).slice(1) });
    }
    hunks.push({ oldStart: h.oldStart || 0, newStart: h.newStart || 0, lines });
  }
  return hunks.length ? { kind: "diff", added, removed, hunks } : null;
}

function parse(jsonlText) {
  const events = [];
  for (const ln of String(jsonlText || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === "text" && b.text && b.text.trim())
          events.push({ kind: "text", text: b.text.trim() });
        else if (b.type === "tool_use")
          events.push({ kind: "tool", tool: b.name || "tool", arg: toolArg(b) });
      }
    }
    const sp = o.toolUseResult && o.toolUseResult.structuredPatch;
    if (Array.isArray(sp) && sp.length) { const d = toDiff(sp); if (d) events.push(d); }
  }
  return events;
}

function renderDiff(e) {
  const out = ['<div class="ov-diffsub">Added ' + e.added + " lines, removed " +
               e.removed + ' lines</div>', '<div class="ov-diff">'];
  for (const h of e.hunks) {
    let oldLn = h.oldStart, newLn = h.newStart;
    for (const l of h.lines) {
      let num, cls;
      if (l.sign === "-") { num = oldLn++; cls = "del"; }
      else if (l.sign === "+") { num = newLn++; cls = "add"; }
      else { num = oldLn++; newLn++; cls = "ctx"; }
      out.push('<div class="ov-line ' + cls + '"><span class="ov-ln">' + num +
               '</span><span class="ov-code">' + esc(l.text) + "</span></div>");
    }
  }
  out.push("</div>");
  return out.join("");
}

function renderEvent(e) {
  if (e.kind === "text") return '<div class="ov-text">' + esc(e.text) + "</div>";
  if (e.kind === "tool")
    return '<div class="ov-tool">• ' + esc(VERB[e.tool] || e.tool) + "(" + esc(e.arg) + ")</div>";
  if (e.kind === "diff") return renderDiff(e);
  return "";
}

function renderHtml(events, opts = {}) {
  const parts = [];
  if (opts.truncatedNote) parts.push('<div class="ov-note">earlier history hidden</div>');
  for (const e of events) parts.push(renderEvent(e));
  return parts.join("\n");
}

module.exports = { parse, renderHtml, esc };
