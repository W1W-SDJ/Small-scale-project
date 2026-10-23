# Capture the pet's window without launching Electron.
#
#   tools\capture.cmd                     # around the pet window
#   tools\capture.cmd -All                # whole virtual screen
#
# (Or directly: powershell -NoProfile -ExecutionPolicy Bypass -File tools\capture.ps1
#  — this machine's execution policy refuses to run .ps1 files otherwise.)
#
# Two things matter here and both are easy to get wrong:
#
#  * DPI awareness. Electron windows are per-monitor DPI aware, so GetWindowRect
#    answers in physical pixels. A DPI-unaware PowerShell would read virtualised
#    coordinates and the crop would land in the wrong place.
#  * CAPTUREBLT. A transparent, always-on-top Electron window is a *layered*
#    window; BitBlt without CAPTUREBLT silently omits it, which is exactly why
#    a plain Graphics.CopyFromScreen() screenshot shows no pet at all.
param(
  [string]$Title = 'Blob Pet',
  [string]$Out = (Join-Path $env:TEMP 'pet-capture.png'),
  [int]$Pad = 48,
  [switch]$All
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class PetCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);

  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

  public const int GWL_EXSTYLE = -20;
  public const int GWL_STYLE = -16;
  public const uint SRCCOPY = 0x00CC0020;
  public const uint CAPTUREBLT = 0x40000000;

  public static void MakeDpiAware() {
    // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { try { SetProcessDpiAwareness(2); } catch { } }
  }

  public static uint ExStyle(IntPtr h) { return (uint)GetWindowLong(h, GWL_EXSTYLE); }
  public static uint Style(IntPtr h) { return (uint)GetWindowLong(h, GWL_STYLE); }

  public static Bitmap Grab(int x, int y, int w, int h) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr bmp = CreateCompatibleBitmap(screen, w, h);
    IntPtr old = SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
    SelectObject(mem, old);
    Bitmap result = Image.FromHbitmap(bmp);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, screen);
    return result;
  }
}
"@ -ReferencedAssemblies System.Drawing

[PetCapture]::MakeDpiAware()

$rect = New-Object PetCapture+RECT

if ($All) {
  Add-Type -AssemblyName System.Windows.Forms
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x, $y, $w, $h = $vs.X, $vs.Y, $vs.Width, $vs.Height
  Write-Host "mode         : whole virtual screen (DPI-aware)"
} else {
  # Match by window title only. A packaged build's process is named after the
  # product ("Blob Pet"), not "electron", so filtering by process name would
  # miss it.
  $proc = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq $Title -and $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $proc) { throw "pet window '$Title' not found - is the pet running?" }
  $hwnd = $proc.MainWindowHandle
  [void][PetCapture]::GetWindowRect($hwnd, [ref]$rect)

  $ex = [PetCapture]::ExStyle($hwnd)
  $st = [PetCapture]::Style($hwnd)
  $dpi = [PetCapture]::GetDpiForWindow($hwnd)
  Write-Host "hwnd         : $hwnd (pid $($proc.Id))"
  Write-Host "window rect  : $($rect.Left),$($rect.Top) - $($rect.Right),$($rect.Bottom)  ($($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)) physical"
  Write-Host "visible      : $([PetCapture]::IsWindowVisible($hwnd))   dpi: $dpi (scale $($dpi / 96.0))"
  Write-Host ("exstyle      : 0x{0:X8}  LAYERED={1} TRANSPARENT={2} NOACTIVATE={3} TOPMOST={4} TOOLWINDOW={5}" -f `
      $ex, [bool]($ex -band 0x80000), [bool]($ex -band 0x20), [bool]($ex -band 0x08000000), [bool]($ex -band 0x8), [bool]($ex -band 0x80))
  Write-Host ("style        : 0x{0:X8}  VISIBLE={1} POPUP={2}" -f `
      $st, [bool]($st -band 0x10000000), [bool]($st -band 0x80000000))
  Write-Host "mode         : pet window + $Pad px padding"

  $x = [Math]::Max(0, $rect.Left - $Pad)
  $y = [Math]::Max(0, $rect.Top - $Pad)
  $w = ($rect.Right - $rect.Left) + 2 * $Pad
  $h = ($rect.Bottom - $rect.Top) + 2 * $Pad
}

$bmp = [PetCapture]::Grab($x, $y, $w, $h)
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "captured     : $x,$y ${w}x${h} -> $Out"
