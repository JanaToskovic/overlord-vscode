// raise.js — bring a VS Code window to the OS foreground.
//
// VS Code exposes no API to raise its own window, let alone somebody else's, so
// we shell out per-OS. Best-effort throughout: any failure is swallowed, because
// a jump that does not raise the window is a small disappointment while a thrown
// exception in the poll would break the board.
//
// Two modes:
//   raiseVSCodeWindow()             every VS Code window. The old behaviour,
//                                   still right when nothing tells them apart.
//   raiseVSCodeWindow(hint|hints)   the ONE window whose title carries a hint.
//                                   Several hints are tried in order of
//                                   confidence, because no single one always
//                                   exists (see normalizeHints below).
//
// Only a window raises itself: cross-window jumps work by asking the owning
// window to do this, never by one window reaching into another (see windows.js).
//
// PLATFORM DIFFERENCE, and it is a real one:
//   Windows  EnumWindows + SetForegroundWindow. Exact, no permission needed.
//   macOS    picking one window needs System Events "AXRaise", which requires
//            the user to grant VS Code Accessibility permission. Without it the
//            script errors and we fall back to activating the app, which brings
//            VS Code forward but leaves the right window for the user to pick.
//            Degraded, never broken.
const cp = require("child_process");

// `hints` is one string or several, tried in order. Several are needed because
// the obvious hint is not always available: a window with NO folder open has an
// empty `workspace.name` and its title is just the active editor plus
// "Visual Studio Code" (seen live: {"label":"no folder","title":""}). Revealing
// the session's terminal first puts that terminal's tab name INTO the title, so
// the tab name is the hint that works when the workspace name cannot.
function raiseVSCodeWindow(hints) {
  try {
    const want = normalizeHints(hints);
    if (process.platform === "win32") return spawnPs(winScript(want));
    if (process.platform === "darwin") return spawnOsa(macScript(want));
  } catch (_) { /* raising is best-effort */ }
}

// Trimmed, de-duplicated, empties dropped. An empty list means "no way to tell
// the windows apart", which is a real state and must degrade to raising them all
// rather than matching everything.
function normalizeHints(hints) {
  const list = Array.isArray(hints) ? hints : [hints];
  const out = [];
  for (const h of list) {
    const s = typeof h === "string" ? h.trim() : "";
    if (s && out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

function spawnPs(script) {
  cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}
function spawnOsa(script) {
  cp.spawn("osascript", ["-e", script]);
}

// A PowerShell single-quoted string ends at the first quote; doubling escapes it.
function psLit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
// AppleScript double-quoted string: backslash first, then the quote itself.
function asLit(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }

// ---- Windows ---------------------------------------------------------------

// Without a label: every Code window, as before. With one: enumerate top-level
// windows and pick the match. Get-Process cannot do this — all VS Code windows
// belong to ONE process, which reports a single MainWindowHandle, so anything
// built on Get-Process can only ever see one window of several.
function winScript(hints) {
  const wants = normalizeHints(hints);
  const head = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public class OvlWin {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc e, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    "}",
    '"@',
    "$ws = New-Object -ComObject WScript.Shell",
  ];
  if (!wants.length) {
    // Un-minimize and foreground every Code window.
    return head.concat([
      "Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {",
      "  if ([OvlWin]::IsIconic($_.MainWindowHandle)) { [void][OvlWin]::ShowWindow($_.MainWindowHandle, 9) }",
      "  $ws.AppActivate($_.Id) | Out-Null",
      "  [void][OvlWin]::SetForegroundWindow($_.MainWindowHandle)",
      "}",
    ]).join("\n");
  }
  return head.concat([
    "$codePids = @{}",
    "Get-Process Code -ErrorAction SilentlyContinue | ForEach-Object { $codePids[[uint32]$_.Id] = $_.Id }",
    "$wants = @(" + wants.map(psLit).join(", ") + ")",
    // Collect every Code window once, then score. Enumerating per hint would
    // walk the window list N times for no benefit.
    "$script:wins = New-Object System.Collections.ArrayList",
    "$cb = [OvlWin+EnumProc]{ param($h, $l)",
    "  if (-not [OvlWin]::IsWindowVisible($h)) { return $true }",
    "  $len = [OvlWin]::GetWindowTextLength($h)",
    "  if ($len -le 0) { return $true }",
    "  $sb = New-Object System.Text.StringBuilder ($len + 1)",
    "  [void][OvlWin]::GetWindowText($h, $sb, $sb.Capacity)",
    "  $p = [uint32]0",
    "  [void][OvlWin]::GetWindowThreadProcessId($h, [ref]$p)",
    "  if ($codePids.ContainsKey($p)) { [void]$script:wins.Add(@{ h = $h; t = $sb.ToString(); pid = $codePids[$p] }) }",
    "  return $true",
    "}",
    "[void][OvlWin]::EnumWindows($cb, [IntPtr]::Zero)",
    "$hit = $null",
    // Hints in order of confidence. For each, VS Code's default title shape
    // "<name> - Visual Studio Code" first, then a loose contains for a
    // customised window.title. A later hint is only consulted if no earlier one
    // matched at all.
    "foreach ($want in $wants) {",
    "  foreach ($w in $script:wins) { if ($w.t -like ('*' + $want + ' - Visual Studio Code')) { $hit = $w; break } }",
    "  if ($hit) { break }",
    "  foreach ($w in $script:wins) { if ($w.t -like ('*' + $want + '*')) { $hit = $w; break } }",
    "  if ($hit) { break }",
    "}",
    "$script:hit = if ($hit) { $hit.h } else { [IntPtr]::Zero }",
    // Re-derive the pid from the matched handle rather than carrying it out of
    // the enumeration callback. A delegate scriptblock does not share scope the
    // way a normal block does, and the value came back empty from in there —
    // which would have left AppActivate with nothing and cost us the foreground
    // rights that SetForegroundWindow depends on.
    "$script:hitPid = 0",
    "if ($script:hit -ne [IntPtr]::Zero) { $hp = [uint32]0; [void][OvlWin]::GetWindowThreadProcessId($script:hit, [ref]$hp); $script:hitPid = [int]$hp }",
    "if ($script:hit -ne [IntPtr]::Zero) {",
    "  if ([OvlWin]::IsIconic($script:hit)) { [void][OvlWin]::ShowWindow($script:hit, 9) }",
    // AppActivate first: Windows blocks SetForegroundWindow from a background
    // process, but once the target process owns the foreground, promoting one of
    // its own windows is allowed.
    "  $ws.AppActivate($script:hitPid) | Out-Null",
    "  [void][OvlWin]::SetForegroundWindow($script:hit)",
    "}",
  ]).join("\n");
}

// ---- macOS -----------------------------------------------------------------

function macScript(hints) {
  const wants = normalizeHints(hints);
  const fallback = 'tell application "Visual Studio Code" to activate';
  if (!wants.length) return fallback;
  // Nested try/on error: each hint is attempted, and the innermost failure lands
  // on plain activate. That last step is what makes this shippable without
  // Accessibility permission — System Events throws, VS Code still comes
  // forward, and the user picks the window.
  let body = "  " + fallback;
  for (let i = wants.length - 1; i >= 0; i--) {
    const attempt = [
      '  tell application "System Events" to tell process "Code"',
      "    set frontmost to true",
      '    perform action "AXRaise" of (first window whose name contains ' + asLit(wants[i]) + ")",
      "  end tell",
    ].join("\n");
    body = ["try", attempt, "on error", indent(body), "end try"].join("\n");
  }
  return body;
}

function indent(s) { return s.split("\n").map((l) => "  " + l).join("\n"); }

module.exports = { raiseVSCodeWindow, winScript, macScript, psLit, asLit, normalizeHints };
