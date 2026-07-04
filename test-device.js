// Unit tests for device.js — run with: node test-device.js
const assert = require("assert");
const D = require("./device");

// serializeGrid: only the four sent fields, newline-terminated, valid JSON
const sessions = [
  { sid: "a", name: "proj", state: "needs", sub: "needs you · permission", color: "#f00", pid: 5, cwd: "x" },
  { sid: "b", name: "web", state: "working", sub: "working" },
];
const line = D.serializeGrid(sessions);
assert.ok(line.endsWith("\n"), "serializeGrid ends with newline");
const obj = JSON.parse(line);
assert.strictEqual(obj.type, "grid");
assert.deepStrictEqual(obj.sessions[0], { sid: "a", name: "proj", state: "needs", sub: "needs you · permission" });
assert.deepStrictEqual(Object.keys(obj.sessions[0]).sort(), ["name", "sid", "state", "sub"]);

// gridSignature + gridChanged: stable when unchanged, differs on any sent field
const sig = D.gridSignature(sessions);
assert.strictEqual(D.gridChanged(sig, sessions), false, "same sessions -> no change");
assert.strictEqual(D.gridChanged(null, sessions), true, "null prev -> changed");
const stateChanged = [{ sid: "a", name: "proj", state: "idle", sub: "idle" }, sessions[1]];
assert.strictEqual(D.gridChanged(sig, stateChanged), true, "state change -> changed");
// fields we do NOT send must not trigger a change
const colorOnly = [{ sid: "a", name: "proj", state: "needs", sub: "needs you · permission", color: "#0f0" }, sessions[1]];
assert.strictEqual(D.gridChanged(sig, colorOnly), false, "color-only change -> no change");

// parseInbound: accept valid jump/pong, reject everything else
assert.deepStrictEqual(D.parseInbound('{"type":"jump","sid":"abc"}'), { type: "jump", sid: "abc" });
assert.deepStrictEqual(D.parseInbound('{"type":"pong"}'), { type: "pong" });
assert.strictEqual(D.parseInbound('{"type":"jump"}'), null, "jump without sid -> null");
assert.strictEqual(D.parseInbound('{"type":"jump","sid":""}'), null, "empty sid -> null");
assert.strictEqual(D.parseInbound("not json"), null);
assert.strictEqual(D.parseInbound('{"type":"other"}'), null);
assert.strictEqual(D.parseInbound("null"), null);

console.log("PASS — all device.js unit tests green");

// --- integration: server accepts a client, pushes grid, routes a jump ---
const net = require("net");
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
(async () => {
  const PORT = 7399;              // test port, avoid the default
  let jumped = null;
  D.start({ port: PORT, onJump: (sid) => { jumped = sid; }, log: () => {} });
  await delay(100);

  const received = [];
  const client = net.connect(PORT, "127.0.0.1");
  client.setEncoding("utf8");
  let buf = "";
  client.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { received.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  await delay(100);

  D.publish([{ sid: "a", name: "proj", state: "needs", sub: "needs you" }]);
  await delay(100);
  const grids = received.map((l) => JSON.parse(l)).filter((m) => m.type === "grid");
  assert.ok(grids.length >= 1, "client received a grid");
  assert.strictEqual(grids[grids.length - 1].sessions[0].sid, "a");

  // unchanged publish -> no new grid
  D.publish([{ sid: "a", name: "proj", state: "needs", sub: "needs you" }]);
  await delay(100);
  const gridsAfter = received.map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } }).filter((m) => m.type === "grid");
  assert.strictEqual(gridsAfter.length, grids.length, "unchanged publish sends nothing new");

  // client taps -> onJump fires with sid
  client.write(JSON.stringify({ type: "jump", sid: "a" }) + "\n");
  await delay(100);
  assert.strictEqual(jumped, "a", "onJump received the tapped sid");

  client.destroy();
  D.stop();
  await delay(50);
  console.log("PASS — device.js server integration green");
  await beaconTest();
  console.log("PASS — device.js beacon green");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });

const dgram = require("dgram");
async function beaconTest() {
  const PORT = 7398;
  const listener = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const got = new Promise((resolve) => listener.on("message", (m) => resolve(m.toString())));
  await new Promise((r) => listener.bind(42424, r));
  D.start({ port: PORT, log: () => {} });
  const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r("TIMEOUT"), 4000))]);
  assert.strictEqual(msg, "OVERLORD:" + PORT, "beacon announces the TCP port");
  listener.close();
  D.stop();
  await new Promise((r) => setTimeout(r, 50));
}
