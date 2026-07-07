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
  if (e.kind === "tool") {
    const head = esc(VERB[e.tool] || e.tool);
    return '<div class="ov-tool">• ' + head + (e.arg ? "(" + esc(e.arg) + ")" : "") + "</div>";
  }
  if (e.kind === "diff") return renderDiff(e);
  return "";
}

function renderHtml(events, opts = {}) {
  const parts = [];
  if (opts.truncatedNote) parts.push('<div class="ov-note">earlier history hidden</div>');
  for (const e of events) parts.push(renderEvent(e));
  return parts.join("\n");
}

const ACT_VERB = { Edit: "Edit", MultiEdit: "Edit", Write: "Write", Read: "Read", Bash: "Bash" };
function baseName(p) { const a = String(p || "").split(/[\\/]/); return a[a.length - 1]; }
function pushAct(arr, s) { if (s && arr[arr.length - 1] !== s) arr.push(s); }
// Keep sidebar activity compact: a command's first line, capped, so a multi-line
// heredoc doesn't dump its whole body into the card DOM.
function firstLine(s) {
  s = String(s || "").split(/\r?\n/)[0].trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

// Parse a tail once and derive everything the sidebar card needs, so the extension
// reads each transcript at most once per tick. awaitFn (agents.awaitReason) is injected
// to keep question-detection out of this module.
function readTail(jsonlTail, awaitFn) {
  let model = "", ctxTokens = 0, lastText = "";
  const activity = [];
  for (const ln of String(jsonlTail || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type !== "assistant" || !o.message) continue;
    const m = o.message;
    if (m.model) model = m.model;
    if (m.usage) {
      const u = m.usage;
      const c = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (c) ctxTokens = c;
    }
    if (Array.isArray(m.content)) for (const b of m.content) {
      if (!b) continue;
      if (b.type === "text" && b.text && b.text.trim()) lastText = b.text.trim();
      else if (b.type === "tool_use") {
        const verb = ACT_VERB[b.name] || b.name;
        const inp = b.input || {};
        const arg = b.name === "Bash" ? firstLine(inp.command) : baseName(inp.file_path);
        pushAct(activity, verb + (arg ? ": " + arg : ""));
      } else if (b.type === "thinking") pushAct(activity, "thinking…");
    }
  }
  return { model, ctxTokens, awaitReason: awaitFn ? awaitFn(lastText) : null,
           activity: activity.slice(-7), lastMsg: firstLine(lastText) };
}

module.exports = { parse, renderHtml, esc, readTail };
