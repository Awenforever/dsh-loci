param(
  [string]$TitleLike = "DeepSeek Harness",
  [string]$Out = "$env:TEMP\loci-shots\gui.png"
)
# Capture a live window, so UI can be verified by looking at it rather than by trusting a rectangle.
#
# PrintWindow with PW_RENDERFULLCONTENT asks the window to render itself, which works for hardware-
# accelerated Chromium where a plain screen copy can come back black. If that produces an empty image
# the fallback copies the screen region the window occupies.

Add-Type -AssemblyName System.Drawing | Out-Null

$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
if (-not ("WinCap" -as [type])) { Add-Type -TypeDefinition $sig }

$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleLike*" } | Select-Object -First 1
if (-not $proc) { Write-Output "no window matching '$TitleLike'"; exit 2 }
Write-Output "window: $($proc.MainWindowTitle) (pid $($proc.Id))"

$h = $proc.MainWindowHandle
[WinCap]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[WinCap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800

$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($h, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output "rect: ${width}x${height} at $($rect.Left),$($rect.Top)"
if ($width -le 0 -or $height -le 0) { Write-Output "window has no size"; exit 3 }

New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

$bmp = New-Object System.Drawing.Bitmap $width, $height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
$ok = [WinCap]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()

if (-not $ok) {
  Write-Output "PrintWindow refused; falling back to screen copy"
  $bmp.Dispose()
  $bmp = New-Object System.Drawing.Bitmap $width, $height
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
  $gfx.Dispose()
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# A capture that is a single flat colour means the render failed (black or white), not that the page is empty.
$check = New-Object System.Drawing.Bitmap $Out
$samples = @()
for ($x = 0; $x -lt $check.Width; $x += [Math]::Max(1, [int]($check.Width / 20))) {
  for ($y = 0; $y -lt $check.Height; $y += [Math]::Max(1, [int]($check.Height / 20))) {
    $samples += $check.GetPixel($x, $y).ToArgb()
  }
}
$distinct = ($samples | Sort-Object -Unique).Count
$check.Dispose()
Write-Output "saved: $Out ($( [Math]::Round((Get-Item $Out).Length / 1024) ) KB) · distinct sampled colours: $distinct"
if ($distinct -le 2) { Write-Output "capture looks blank - the window may be on a different desktop session"; exit 4 }
exit 0
