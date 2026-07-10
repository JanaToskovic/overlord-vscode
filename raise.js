// raise.js — bring the VS Code window to the OS foreground.
// VS Code exposes no API to raise its own window, so we shell out per-OS.
// Best-effort: any failure is swallowed so a tap can never break the extension.
const cp = require("child_process");

function raiseVSCodeWindow() {
  try {
    if (process.platform === "win32") return raiseWindows();
    if (process.platform === "darwin") return raiseMac();
  } catch (_) { /* raising is best-effort */ }
}

// Restore (un-minimize) and foreground every VS Code main window. The target
// setup is a single window, so activating all Code windows is fine.
function raiseWindows() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class Win {",
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    "}",
    '"@',
    "$ws = New-Object -ComObject WScript.Shell",
    "Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {",
    "  if ([Win]::IsIconic($_.MainWindowHandle)) { [Win]::ShowWindow($_.MainWindowHandle, 9) }",
    "  $ws.AppActivate($_.Id) | Out-Null",
    "  [Win]::SetForegroundWindow($_.MainWindowHandle) | Out-Null",
    "}",
  ].join("\n");
  cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
}

function raiseMac() {
  cp.spawn("osascript", ["-e", 'tell application "Visual Studio Code" to activate']);
}

module.exports = { raiseVSCodeWindow };
