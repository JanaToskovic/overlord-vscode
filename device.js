// Overlord device transport — mirrors the session grid to an external screen
// over newline-delimited JSON on raw TCP, and receives tap-to-jump back.
// Dependency-free (core Node only). Pure helpers below are unit-tested; the
// socket/beacon/heartbeat shell is added in later tasks.

// Only these four fields go to the screen; the device owns its own palette.
function toWire(s) { return { sid: s.sid, name: s.name, state: s.state, sub: s.sub }; }

function serializeGrid(sessions) {
  return JSON.stringify({ type: "grid", sessions: sessions.map(toWire) }) + "\n";
}

// Stable signature of exactly the sent fields, so we publish only on real change.
function gridSignature(sessions) {
  return sessions.map((s) => `${s.sid}|${s.state}|${s.name}|${s.sub}`).join("~");
}

function gridChanged(prevSig, sessions) {
  return prevSig !== gridSignature(sessions);
}

function parseInbound(line) {
  let o; try { o = JSON.parse(line); } catch (_) { return null; }
  if (!o || typeof o !== "object") return null;
  if (o.type === "jump" && typeof o.sid === "string" && o.sid) return { type: "jump", sid: o.sid };
  if (o.type === "pong") return { type: "pong" };
  return null;
}

const net = require("net");
const dgram = require("dgram");
const BEACON_PORT = 42424;

let server = null;      // net.Server
let sock = null;        // the one connected screen
let lastSig = null;     // last published signature (per connection)
let jumpCb = () => {};
let logFn = () => {};
let lastRxAt = 0;       // last time we heard anything from the screen
let beacon = null;      // dgram socket
let beaconTimer = null;
let pingTimer = null;

function start(opts = {}) {
  if (server) return;                       // idempotent
  const port = opts.port || 7331;
  jumpCb = opts.onJump || (() => {});
  logFn = opts.log || (() => {});
  server = net.createServer(onConnection);
  server.on("error", (e) => logFn("device server error: " + e.message));
  server.listen(port, () => logFn("Overlord device server on :" + port));
  startBeacon(port);
  pingTimer = setInterval(() => tick(), 3000);
}

function startBeacon(port) {
  beacon = dgram.createSocket({ type: "udp4", reuseAddr: true });
  beacon.on("error", () => {});
  beacon.bind(() => { try { beacon.setBroadcast(true); } catch (_) {} });
  const announce = () => {
    if (!beacon) return;
    const msg = Buffer.from("OVERLORD:" + port);
    try { beacon.send(msg, 0, msg.length, BEACON_PORT, "255.255.255.255"); } catch (_) {}
  };
  beaconTimer = setInterval(announce, 2000);
  announce();                       // announce immediately on start
}

// Heartbeat: ping the screen; drop a screen that has been silent too long so a
// half-open socket is detected in seconds and the screen can reconnect.
function tick() {
  if (!sock) return;
  if (Date.now() - lastRxAt > 8000) { try { sock.destroy(); } catch (_) {} sock = null; return; }
  try { sock.write(JSON.stringify({ type: "ping" }) + "\n"); } catch (_) {}
}

function onConnection(s) {
  if (sock) { try { sock.destroy(); } catch (_) {} }   // one screen: newest wins
  sock = s;
  lastSig = null;                            // force a full grid to the new screen
  lastRxAt = Date.now();
  s.setEncoding("utf8");
  let buf = "";
  s.on("data", (chunk) => {
    lastRxAt = Date.now();
    buf += chunk; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = parseInbound(line);
      if (msg && msg.type === "jump") { try { jumpCb(msg.sid); } catch (_) {} }
    }
  });
  s.on("error", () => {});
  s.on("close", () => { if (sock === s) sock = null; });
  logFn("screen connected: " + (s.remoteAddress || "?"));
}

function publish(sessions) {
  if (!sock) return;
  if (!gridChanged(lastSig, sessions)) return;
  lastSig = gridSignature(sessions);
  try { sock.write(serializeGrid(sessions)); } catch (_) {}
}

function stop() {
  if (pingTimer) clearInterval(pingTimer);
  if (beaconTimer) clearInterval(beaconTimer);
  try { if (sock) sock.destroy(); } catch (_) {}
  try { if (server) server.close(); } catch (_) {}
  try { if (beacon) beacon.close(); } catch (_) {}
  sock = server = beacon = null;
  pingTimer = beaconTimer = null;
  lastSig = null;
}

module.exports = { start, publish, stop, serializeGrid, gridSignature, gridChanged, parseInbound };
