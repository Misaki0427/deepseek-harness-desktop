Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-Rounded([System.Drawing.Image]$src, [int]$size, [single]$radiusPct) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $path = RoundedPath 0 0 $size $size ([single]($size * $radiusPct))
    $g.SetClip($path)
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.ResetClip()
    $g.Dispose()
    $path.Dispose()
    return $bmp
}

$src = [System.Drawing.Image]::FromFile('icon-src-tray.png')

$t32 = New-Rounded $src 32 0.22
$t32.Save('tray.png', [System.Drawing.Imaging.ImageFormat]::Png)
$t32.Dispose()

$t16 = New-Rounded $src 16 0.22
$t16.Save('tray-16.png', [System.Drawing.Imaging.ImageFormat]::Png)
$t16.Dispose()

$preview = New-Rounded $src 256 0.22
$preview.Save('tray-preview.png', [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

$src.Dispose()
Write-Output 'DONE'
