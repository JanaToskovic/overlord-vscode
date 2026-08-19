// raise.js — bring a VS Code window to the OS foreground.
//
// VS Code exposes no API to raise its own window, let alone somebody else's, so
// we shell out per-OS. Best-effort throughout: any failure is swallowed, because
// a jump that does not raise the window is a small disappointment while a thrown
// exception in the poll would break the board.
//
// Two modes:
//   raiseVSCodeWindow()        every VS Code window. The old behaviour, still
//                              right when there is nothing to disambiguate.
//   raiseVSCodeWindow(label)   the ONE window whose title carries `label`
//                              (a workspace name such as "CoS").
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

function raiseVSCodeWindow(label) {
  try {
    const want = typeof label === "string" ? label.trim() : "";
    if (process.platform === "win32") return spawnPs(winScript(want));
    if (process.platform === "darwin") return spawnOsa(macScript(want));
  } catch (_) { /* raising is best-effort */ }
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
function winScript(label) {
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
  if (!label) {
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
    "$want = " + psLit(label),
    "$script:hit = [IntPtr]::Zero",
    "$script:hitPid = 0",
    "$script:exact = $false",
    "$cb = [OvlWin+EnumProc]{ param($h, $l)",
    "  if (-not [OvlWin]::IsWindowVisible($h)) { return $true }",
    "  $len = [OvlWin]::GetWindowTextLength($h)",
    "  if ($len -le 0) { return $true }",
    "  $sb = New-Object System.Text.StringBuilder ($len + 1)",
    "  [void][OvlWin]::GetWindowText($h, $sb, $sb.Capacity)",
    "  $t = $sb.ToString()",
    "  $p = [uint32]0",
    "  [void][OvlWin]::GetWindowThreadProcessId($h, [ref]$p)",
    "  if (-not $codePids.ContainsKey($p)) { return $true }",
    // VS Code's default title ends "<folder> - Visual Studio Code". Prefer that
    // exact shape; fall back to a loose match for a customized window.title.
    "  if ($t -like ('*' + $want + ' - Visual Studio Code')) { $script:hit = $h; $script:hitPid = $codePids[$p]; $script:exact = $true; return $false }",
    "  if (-not $script:exact -and $script:hit -eq [IntPtr]::Zero -and $t -like ('*' + $want + '*')) { $script:hit = $h; $script:hitPid = $codePids[$p] }",
    "  return $true",
    "}",
    "[void][OvlWin]::EnumWindows($cb, [IntPtr]::Zero)",
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

function macScript(label) {
  if (!label) return 'tell application "Visual Studio Code" to activate';
  // If Accessibility permission is missing, System Events throws and we still
  // bring VS Code forward. The user then picks the window themselves, which is
  // what they have to do today anyway.
  return [
    "try",
    '  tell application "System Events" to tell process "Code"',
    "    set frontmost to true",
    "    perform action \"AXRaise\" of (first window whose name contains " + asLit(label) + ")",
    "  end tell",
    "on error",
    '  tell application "Visual Studio Code" to activate',
    "end try",
  ].join("\n");
}

module.exports = { raiseVSCodeWindow, winScript, macScript, psLit, asLit };
