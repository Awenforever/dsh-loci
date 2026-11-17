<#
.SYNOPSIS
  Capture the real DSH window on this machine.

.DESCRIPTION
  Acceptance for a UI change has to be a picture of the running application, not a preview page standing in
  for it. The DSH desktop shell renders the same web GUI the browser does, so capturing its window is a real
  screenshot — and unlike the local HTTP port it needs no per-launch token.

.EXAMPLE
  powershell -File scripts/diag/capture-dsh.ps1 -Out shot.png

.EXAMPLE
  powershell -File scripts/diag/capture-dsh.ps1 -Out shot.png -Full

  -Full captures the whole screen instead of just the DSH window, which is the honest thing to do when the
  thing being judged is a popover or a modal that extends past the window.
#>
param(
  [string]$Out = "$env:TEMP\dsh-shot.png",
  [switch]$Full,
  [string]$TitleMatch = 'DeepSeek Harness'
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshCapture {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleMatch*" } |
  Select-Object -First 1
if ($null -eq $proc) { Write-Error "no visible window matching '$TitleMatch'"; exit 1 }

# A minimised window has no drawable surface; restore it and give the compositor a moment.
if ([DshCapture]::IsIconic($proc.MainWindowHandle)) {
  [DshCapture]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 700
}
[DshCapture]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400

if ($Full) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
} else {
  $rect = New-Object DshCapture+RECT
  [DshCapture]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
  $x = [Math]::Max(0, $rect.Left); $y = [Math]::Max(0, $rect.Top)
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
}
if ($w -le 0 -or $h -le 0) { Write-Error "window has no drawable area ($w x $h)"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()

Write-Output "$Out"
Write-Output "window='$($proc.MainWindowTitle)' size=${w}x${h} full=$($Full.IsPresent)"
