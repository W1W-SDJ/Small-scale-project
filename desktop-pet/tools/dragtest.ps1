# Automated drag test for the pet — one real mouse drag, then a check that the
# window followed the cursor by exactly the requested DIP distance.
#
#   tools\dragtest.cmd            # dry run: reports state, moves NOTHING
#   tools\dragtest.cmd -Yes       # actually injects a drag
#
# THIS SCRIPT TAKES OVER THE REAL CURSOR. It moves the physical pointer onto the
# pet, holds the left button and drags it across the desktop, so it must never
# run without -Yes while somebody is using the machine. It restores the cursor
# afterwards.
#
# Finding the window needs a DPI-aware process: this pet runs on a 150% display,
# where a DPI-unaware process sees virtualised coordinates (171x352) instead of
# real physical pixels (257x528). Everything here is therefore in physical
# pixels, and DIP values are converted with the window's own DPI.
#
# The mouse helpers must NOT be named LeftDown/LeftUp: PowerShell resolves names
# case-insensitively, so `LeftDown` collides with a `LEFTDOWN` constant field and
# the method call is rejected.
param(
  [int]$Dx = -160,
  [int]$Dy = -120,
  [int]$Steps = 24,
  [double]$Scale = 0,
  [switch]$Yes,
  [string]$Title = 'Blob Pet',
  [string]$StateFile = "$env:APPDATA\Blob Pet\pet-state.json"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);

  const uint DOWN = 0x0002;
  const uint UP = 0x0004;

  public static void MakeDpiAware() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }   // PER_MONITOR_AWARE_V2
    catch { try { SetProcessDpiAwareness(2); } catch { } }
  }
  public static bool IgnoresMouse(IntPtr h) { return (GetWindowLong(h, -20) & 0x20) != 0; }
  public static void PressLeft() { mouse_event(DOWN, 0, 0, 0, IntPtr.Zero); }
  public static void ReleaseLeft() { mouse_event(UP, 0, 0, 0, IntPtr.Zero); }
}
"@

[PetWin]::MakeDpiAware()

# Match by window title only: a packaged build's process is named after the
# product ("Blob Pet"), not "electron".
$proc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -eq $Title -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $proc) { throw "pet window '$Title' not found - is the pet running?" }
$hwnd = $proc.MainWindowHandle

$rect = New-Object PetWin+RECT
[void][PetWin]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
$dpi = [PetWin]::GetDpiForWindow($hwnd)
if ($Scale -le 0) { $Scale = $dpi / 96.0 }

Write-Host "hwnd         : $hwnd (pid $($proc.Id))"
Write-Host "dpi          : $dpi  -> scale $Scale"
Write-Host "window rect  : $($rect.Left),$($rect.Top) ${w}x${h} physical  (visible=$([PetWin]::IsWindowVisible($hwnd)))"
Write-Host "             : $([Math]::Round($w / $Scale, 1))x$([Math]::Round($h / $Scale, 1)) DIP"

if (-not (Test-Path $StateFile)) { throw "no state file at $StateFile" }
$before = (Get-Content $StateFile -Raw | ConvertFrom-Json).position
Write-Host "before       : state DIP $($before.x),$($before.y)"

# 62% down the window is mid-body, which is always opaque in the hit mask.
$aimX = [int]($rect.Left + $w * 0.5)
$aimY = [int]($rect.Top + $h * 0.62)
Write-Host "aim          : physical $aimX,$aimY"

if (-not $Yes) {
  Write-Host ''
  Write-Host 'DRY RUN - nothing was moved.' -ForegroundColor Yellow
  Write-Host 'This script injects REAL mouse input: it takes over your cursor, presses the'
  Write-Host 'left button on the pet and drags it across the desktop. Re-run with -Yes when'
  Write-Host 'you are not using the machine.'
  exit 0
}

$origin = New-Object PetWin+POINT
[void][PetWin]::GetCursorPos([ref]$origin)
Write-Host "cursor       : moving from $($origin.X),$($origin.Y) - will be restored" -ForegroundColor Yellow

try {
  [void][PetWin]::SetCursorPos($aimX, $aimY)

  # The pet makes its transparent pixels click-through, so a click only lands once
  # the window has noticed the cursor is over an opaque one. Wait for that state
  # instead of guessing a delay: it is the difference between a real drag and a
  # click that silently goes to the desktop.
  $clickable = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 100
    if (-not [PetWin]::IgnoresMouse($hwnd)) { $clickable = $true; break }
  }
  Write-Host "clickable    : $clickable (after $($i * 100)ms; ignoring-mouse flag is now $([PetWin]::IgnoresMouse($hwnd)))"
  if (-not $clickable) { throw 'window stayed click-through at the aim point - cannot drag' }

  [PetWin]::PressLeft()
  Start-Sleep -Milliseconds 150
  for ($i = 1; $i -le $Steps; $i++) {
    [void][PetWin]::SetCursorPos([int]($aimX + ($Dx * $Scale) * $i / $Steps), [int]($aimY + ($Dy * $Scale) * $i / $Steps))
    Start-Sleep -Milliseconds 30
  }
  Start-Sleep -Milliseconds 150
  [PetWin]::ReleaseLeft()
  Start-Sleep -Milliseconds 800
} finally {
  # Always hand the pointer back, even if the drag threw.
  [PetWin]::ReleaseLeft()
  Start-Sleep -Milliseconds 50
  [void][PetWin]::SetCursorPos($origin.X, $origin.Y)
  Write-Host "cursor       : restored to $($origin.X),$($origin.Y)"
}

$rect2 = New-Object PetWin+RECT
[void][PetWin]::GetWindowRect($hwnd, [ref]$rect2)
$after = (Get-Content $StateFile -Raw | ConvertFrom-Json).position
$movedX = $after.x - $before.x
$movedY = $after.y - $before.y

Write-Host "after        : state DIP $($after.x),$($after.y)"
Write-Host "window rect  : $($rect2.Left),$($rect2.Top) $($rect2.Right - $rect2.Left)x$($rect2.Bottom - $rect2.Top) physical (was $($rect.Left),$($rect.Top) ${w}x${h})"
Write-Host "moved        : $movedX,$movedY DIP (expected $Dx,$Dy)"
Write-Host "size drift   : $($rect2.Right - $rect2.Left - $w) x $($rect2.Bottom - $rect2.Top - $h) physical"

$okMove = [Math]::Abs($movedX - $Dx) -le 3 -and [Math]::Abs($movedY - $Dy) -le 3
$okSize = [Math]::Abs($rect2.Right - $rect2.Left - $w) -le 3 -and [Math]::Abs($rect2.Bottom - $rect2.Top - $h) -le 3
if ($okMove -and $okSize) {
  Write-Host 'PASS - the pet followed the cursor and kept its size'
} else {
  if (-not $okMove) { Write-Host 'FAIL - the pet did not follow the cursor' }
  if (-not $okSize) { Write-Host 'FAIL - the window changed size during the drag' }
  exit 1
}
