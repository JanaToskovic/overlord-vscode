// Unit tests for windows.js — run with: node test-windows.js
//
// Two windows are simulated by loading the module twice from a clean require
// cache, each init'd with its own id but the same folder. That is exactly the
// real arrangement: separate extension hosts, one shared directory.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-windows-"));

function load() {
  delete require.cache[require.resolve("./windows")];
  return require("./windows");
}
function sids(...xs) { return new Set(xs); }

let now = 1000000;

// Two windows: A ("CoS") owns session s1, B ("FAI") owns s2. s3 is an orphan
// whose terminal was closed, so nobody claims it.
const A = load();
assert.strictEqual(A.init({ dir: DIR, id: "aaa", label: "CoS", pid: 11 }), true, "init creates the folder");
const B = load();
B.init({ dir: DIR, id: "bbb", label: "FAI", pid: 22 });

A.publish(sids("s1"), now);
B.publish(sids("s2"), now);

// ---- locate: the whole point of the registry --------------------------------
assert.deepStrictEqual(A.locate("s1", sids("s1"), now), { where: "here", label: "" });
assert.deepStrictEqual(A.locate("s2", sids("s1"), now), { where: "peer", label: "FAI" });
assert.deepStrictEqual(A.locate("s3", sids("s1"), now), { where: "none", label: "" },
  "a session no live window claims is an orphan, not an error");
// and symmetrically, so neither window is privileged
assert.deepStrictEqual(B.locate("s1", sids("s2"), now), { where: "peer", label: "CoS" });

// A window that stopped publishing is gone. Its sessions must not keep claiming
// to live there: STALE_MS is what stops a closed window haunting the board.
assert.strictEqual(A.peers(now + A.STALE_MS + 1).length, 0, "a silent window goes stale");
assert.deepStrictEqual(A.locate("s2", sids("s1"), now + A.STALE_MS + 1), { where: "none", label: "" });
B.publish(sids("s2"), now);   // B is alive again

// retire() is the clean exit: gone immediately, not after STALE_MS.
const C = load();
C.init({ dir: DIR, id: "ccc", label: "Temp", pid: 33 });
C.publish(sids("s9"), now);
assert.strictEqual(A.locate("s9", sids("s1"), now).where, "peer");
C.retire();
assert.strictEqual(A.locate("s9", sids("s1"), now).where, "none", "a retired window disappears at once");

// ---- shared terminal names --------------------------------------------------
// A session's display name is its terminal TAB name, and only the window hosting
// the terminal can resolve it. Without sharing, every foreign card falls back to
// the folder and three sessions in one project all read "CoS".
{
  const named = new Map([["s1", "BD vertical sizes"]]);
  A.publish(named, now);
  assert.strictEqual(B.peerName("s1", now), "BD vertical sizes", "a peer sees the real name");
  assert.strictEqual(A.peerName("s1", now), "", "never our own: we already have it locally");
  assert.strictEqual(B.peerName("s404", now), "", "unknown session -> no name, caller keeps its fallback");
  // A Set still works, for a peer running an older build that publishes no names.
  A.publish(sids("s1"), now);
  assert.strictEqual(B.peerName("s1", now), "", "no names published -> empty, not a crash");
  assert.strictEqual(B.locate("s1", sids("s2"), now).where, "peer", "and location still works");
  // An empty name must not be published as if it were real.
  A.publish(new Map([["s1", ""]]), now);
  assert.strictEqual(B.peerName("s1", now), "");
  A.publish(named, now);   // restore for the assertions below
}

// ---- sound: once per machine ------------------------------------------------
assert.strictEqual(A.shouldPlaySound("s1", sids("s1"), now), true, "the owner plays it");
assert.strictEqual(B.shouldPlaySound("s1", sids("s2"), now), false, "a non-owner stays quiet");
// exactly one window makes a noise for an owned session
assert.strictEqual(
  [A.shouldPlaySound("s1", sids("s1"), now), B.shouldPlaySound("s1", sids("s2"), now)].filter(Boolean).length,
  1, "an owned session sounds exactly once across the machine");
// an orphan is owned by nobody, so the lowest id speaks for it — still exactly once
assert.strictEqual(
  [A.shouldPlaySound("s3", sids("s1"), now), B.shouldPlaySound("s3", sids("s2"), now)].filter(Boolean).length,
  1, "an orphan sounds exactly once too");
assert.strictEqual(A.shouldPlaySound("s3", sids("s1"), now), true, "lowest id takes the orphan");

// ---- jump requests ----------------------------------------------------------
assert.strictEqual(A.requestJump("s2", now), true);
assert.strictEqual(A.requestPending("s2"), true, "pending until the owner takes it");
assert.deepStrictEqual(A.claimRequests(sids("s1"), now), [],
  "a window never claims a request for a session it does not own");
assert.deepStrictEqual(B.claimRequests(sids("s2"), now), ["s2"], "the owner claims it");
assert.strictEqual(A.requestPending("s2"), false, "claiming consumes the request");
assert.deepStrictEqual(B.claimRequests(sids("s2"), now), [], "and it is claimed only once");

// A window must not answer its own request: it already jumped locally.
B.requestJump("s2", now);
assert.deepStrictEqual(B.claimRequests(sids("s2"), now), [], "own request is ignored");
B.cancelRequest("s2");

// Nobody home: the request ages out rather than firing at some unrelated moment.
A.requestJump("s3", now);
assert.deepStrictEqual(B.claimRequests(sids("s3"), now + A.REQ_TTL_MS + 1), [], "a stale request is dropped");
assert.strictEqual(A.requestPending("s3"), false, "and cleaned up");

// ---- it must never throw ----------------------------------------------------
// Corrupt files are guaranteed eventually: a window dies mid-write, a folder is
// synced. The board has to survive it.
fs.writeFileSync(path.join(DIR, "w-corrupt.json"), "{not json", "utf8");
fs.writeFileSync(path.join(DIR, "req-corrupt.json"), "", "utf8");
assert.doesNotThrow(() => A.all(now), "corrupt window file is skipped");
assert.doesNotThrow(() => A.claimRequests(sids("s1"), now), "corrupt request file is skipped");
assert.ok(A.all(now).every((w) => w.id !== "corrupt"));

// An unusable folder degrades to "I don't know", never to a crash.
const D = load();
// A path whose parent is a FILE: mkdir cannot succeed, however recursive it is.
assert.strictEqual(D.init({ dir: path.join(DIR, "w-corrupt.json", "sub"), id: "ddd", label: "X", pid: 44 }), false);
assert.strictEqual(D.ready(), false);
assert.doesNotThrow(() => D.publish(sids("s1"), now));
assert.deepStrictEqual(D.locate("s1", sids(), now), { where: "none", label: "" });
assert.strictEqual(D.shouldPlaySound("s1", sids(), now), true,
  "with no registry, fall back to the old behaviour rather than going silent");

fs.rmSync(DIR, { recursive: true, force: true });
console.log("PASS — windows.js: registry, orphans, one sound per machine, jump requests");
