// windows.js — who owns which session, across every open VS Code window.
//
// The session list comes from `claude agents --json` and is machine-wide, but a
// terminal only exists inside ONE window, and VS Code gives an extension no way
// to see into another window or to focus it. So each window publishes what it
// owns to a shared folder and reads everyone else's file. That is the whole
// mechanism: no server, no ports, no dependency, and it rides the poll that
// already runs every couple of seconds.
//
// Jumping works the same way in reverse. A window cannot pull another window to
// the front, but a window CAN raise itself (raise.js). So a jump to a foreign
// session is a request left in the folder; the window that owns the session sees
// it on its next poll, reveals its own terminal and raises itself.
//
// Everything here is best-effort by design: a corrupt or half-written file, a
// window killed mid-write, a folder that cannot be created — none of it may ever
// break the board. Failures degrade to "I don't know where that lives", which is
// exactly the state we were in before this file existed.

const fs = require("fs");
const path = require("path");

// A window is live if it has published within this window of time. Three polls
// at the default 2500ms, so one slow poll never makes a window look dead.
const STALE_MS = 10000;
// A jump request nobody claims is stale; the asker gives up well before this.
const REQ_TTL_MS = 15000;
// Junk from a window that was killed rather than deactivated cleanly.
const SWEEP_MS = 300000;

const OWN_PREFIX = "w-";
const REQ_PREFIX = "req-";

let _dir = null;
let _id = null;
let _label = null;
let _title = null;
let _pid = null;
let _lastSweep = 0;

// A window needs TWO names and they are often different:
//   label  what a human calls it, shown on cards ("CoS")
//   title  what VS Code actually writes into the OS window title, which is the
//          only thing raise.js can match on. For a multi-root workspace that is
//          "Untitled (Workspace)", which nobody wants to read on a card.
// Verified on a real two-window setup: titles were "CoS - Visual Studio Code"
// and "... - Untitled (Workspace) - Visual Studio Code".
function init(opts) {
  _dir = opts.dir;
  _id = opts.id;
  _label = opts.label || "";
  _title = opts.title || "";
  _pid = opts.pid;
  try { fs.mkdirSync(_dir, { recursive: true }); } catch (_) { _dir = null; }
  return !!_dir;
}

function ready() { return !!_dir; }
function selfId() { return _id; }
function selfLabel() { return _label; }

// Written whole then renamed: a reader can never see half a file.
function writeAtomic(file, obj) {
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) {}
    return false;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function list(prefix) {
  try { return fs.readdirSync(_dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")); }
  catch (_) { return []; }
}

// ---- publishing -------------------------------------------------------------

// Called on every poll with the sessions whose terminal THIS window resolved.
// Accepts a Set of sids, or a Map of sid -> terminal tab name.
//
// The names matter more than they look. A session's display name is its
// TERMINAL TAB name, and only the window hosting that terminal can resolve it;
// everywhere else it falls back to the folder, so a peer's cards all read "CoS",
// "CoS", "CoS". Publishing the names is what lets another window show
// "BD vertical sizes" instead of the folder three times over.
function publish(sids, now) {
  if (!_dir) return false;
  sweep(now);
  const names = {};
  let sidList = [];   // NOT `list`: that is the module's file-listing helper
  if (sids instanceof Map) {
    sidList = Array.from(sids.keys());
    for (const [sid, n] of sids) if (n) names[sid] = String(n);
  } else {
    sidList = Array.from(sids || []);
  }
  return writeAtomic(path.join(_dir, OWN_PREFIX + _id + ".json"), {
    id: _id, label: _label, title: _title, pid: _pid, sids: sidList, names, ts: now,
  });
}

// On deactivate. Without this a closed window lingers for STALE_MS and a card
// briefly claims to live somewhere that is already gone.
function retire() {
  if (!_dir) return;
  try { fs.unlinkSync(path.join(_dir, OWN_PREFIX + _id + ".json")); } catch (_) {}
}

// ---- reading ----------------------------------------------------------------

// Every window that has published recently, self included, oldest id first so
// any tie-break over this list is stable in every window at once.
function all(now) {
  if (!_dir) return [];
  const out = [];
  for (const f of list(OWN_PREFIX)) {
    const w = readJson(path.join(_dir, f));
    if (!w || !w.id || !Array.isArray(w.sids)) continue;
    if (now - (w.ts || 0) > STALE_MS) continue;
    out.push(w);
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

function peers(now) { return all(now).filter((w) => w.id !== _id); }

// Where a session lives, for the card and the tooltip.
//   { where: "here" }                  its terminal is in this window
//   { where: "peer", label: "FAI" }    another window owns it
//   { where: "none" }                  no live window claims it: orphaned
// "none" is a real state, not an error: a session outlives its terminal when the
// tab is closed, and the process keeps running with nowhere to draw.
function locate(sid, mySids, now) {
  if (mySids && mySids.has && mySids.has(sid)) return { where: "here", label: "" };
  for (const w of peers(now)) {
    if (w.sids.indexOf(sid) !== -1) return { where: "peer", label: w.label || "another window" };
  }
  return { where: "none", label: "" };
}

// The terminal tab name a PEER window resolved for this session, so its card can
// carry the same name here as it does over there. "" when no peer knows it, in
// which case the caller keeps its own fallback.
function peerName(sid, now) {
  if (!_dir) return "";
  for (const w of peers(now)) {
    if (w.names && w.names[sid]) return String(w.names[sid]);
  }
  return "";
}

// ---- the alert sound --------------------------------------------------------

// One sound per machine, not one per open window. The window that owns the
// session speaks for it. Nobody owns an orphan, so the lowest window id takes
// it: `all()` is sorted identically everywhere, so exactly one window agrees
// that it is first.
function shouldPlaySound(sid, mySids, now) {
  if (!_dir) return true;                 // registry unavailable: behave as before
  if (mySids && mySids.has && mySids.has(sid)) return true;
  const live = all(now);
  if (live.length <= 1) return true;      // only us: nothing to coordinate with
  for (const w of live) {
    if (w.id === _id) continue;
    if (w.sids.indexOf(sid) !== -1) return false;   // its owner will play it
  }
  return live[0] && live[0].id === _id;
}

// ---- jump requests ----------------------------------------------------------

function requestJump(sid, now) {
  if (!_dir) return false;
  return writeAtomic(path.join(_dir, REQ_PREFIX + sid + ".json"), { sid, from: _id, ts: now });
}

// True once the owning window has taken the request. The asker polls this for a
// few seconds so it can say what happened instead of leaving a click unanswered.
function requestPending(sid) {
  if (!_dir) return false;
  try { return fs.existsSync(path.join(_dir, REQ_PREFIX + sid + ".json")); } catch (_) { return false; }
}

function cancelRequest(sid) {
  if (!_dir) return;
  try { fs.unlinkSync(path.join(_dir, REQ_PREFIX + sid + ".json")); } catch (_) {}
}

// Called on every poll. Returns the sessions THIS window owns that somebody has
// asked to be taken to, and consumes the requests so no window acts twice.
function claimRequests(mySids, now) {
  if (!_dir || !mySids) return [];
  const out = [];
  for (const f of list(REQ_PREFIX)) {
    const p = path.join(_dir, f);
    const r = readJson(p);
    if (!r || !r.sid) { try { fs.unlinkSync(p); } catch (_) {} continue; }
    if (now - (r.ts || 0) > REQ_TTL_MS) { try { fs.unlinkSync(p); } catch (_) {} continue; }
    if (r.from === _id) continue;                     // our own ask; we already handled it locally
    if (!(mySids.has && mySids.has(r.sid))) continue; // not ours to answer
    try { fs.unlinkSync(p); } catch (_) { continue; } // lost the race: let the winner have it
    out.push(r.sid);
  }
  return out;
}

// ---- housekeeping -----------------------------------------------------------

// A window killed outright (crash, power loss) leaves its file behind. Removing
// it is cosmetic, since anything past STALE_MS is already ignored, but the
// folder should not grow forever.
function sweep(now) {
  if (!_dir || now - _lastSweep < SWEEP_MS) return;
  _lastSweep = now;
  for (const f of list(OWN_PREFIX).concat(list(REQ_PREFIX))) {
    const p = path.join(_dir, f);
    const j = readJson(p);
    if (!j || now - (j.ts || 0) > SWEEP_MS) { try { fs.unlinkSync(p); } catch (_) {} }
  }
}

module.exports = {
  init, ready, selfId, selfLabel,
  publish, retire, all, peers, locate, peerName,
  shouldPlaySound,
  requestJump, requestPending, cancelRequest, claimRequests,
  sweep,
  STALE_MS, REQ_TTL_MS,
};
