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

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function New-Ico([System.Drawing.Image]$src, [string]$outPath, [single]$radiusPct) {
    $sizes = @(256, 128, 64, 48, 32, 16)
    $pngs = @()
    foreach ($s in $sizes) {
        $b = New-Rounded $src $s $radiusPct
        $ms = New-Object System.IO.MemoryStream
        $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngs += , $ms.ToArray()
        $b.Dispose()
        $ms.Dispose()
    }
    $out = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($out)
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $s = $sizes[$i]
        if ($s -ge 256) { $s = 0 }
        $bw.Write([byte]$s)
        $bw.Write([byte]$s)
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([uint32]$pngs[$i].Length)
        $bw.Write([uint32]$offset)
        $offset += $pngs[$i].Length
    }
    foreach ($p in $pngs) { $bw.Write($p) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($outPath, $out.ToArray())
    $bw.Dispose()
    $out.Dispose()
    Write-Output ('ico written: ' + $outPath)
}

# ---------- sources ----------
$app      = [System.Drawing.Image]::FromFile('icon-src-04.png')
$install  = [System.Drawing.Image]::FromFile('icon-src-01.png')
$traySrc  = [System.Drawing.Image]::FromFile('icon-src-02.png')
$themeSrc = [System.Drawing.Image]::FromFile('icon-src-03.png')

# ---------- app icon (04) ----------
New-Ico $app 'icon.ico' 0.22
$app512 = New-Rounded $app 512 0.22
Save-Png $app512 'app-icon.png'
$app512.Dispose()

# ---------- installer icon (01) ----------
New-Ico $install 'installer-icon.ico' 0.22

# ---------- tray icon (02) ----------
$t32 = New-Rounded $traySrc 32 0.22
Save-Png $t32 'tray.png'
$t32.Dispose()
$t16 = New-Rounded $traySrc 16 0.22
Save-Png $t16 'tray-16.png'
$t16.Dispose()

# ---------- theme (03): emblem + blurred background ----------
$emblem = New-Rounded $themeSrc 512 0.22
Save-Png $emblem 'theme-emblem.png'
$emblem.Dispose()

$small = New-Object System.Drawing.Bitmap(110, 110)
$gs = [System.Drawing.Graphics]::FromImage($small)
$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gs.DrawImage($themeSrc, 0, 0, 110, 110)
$gs.Dispose()

$bg = New-Object System.Drawing.Bitmap(640, 640)
$gb = [System.Drawing.Graphics]::FromImage($bg)
$gb.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gb.DrawImage($small, 0, 0, 640, 640)
$over = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 20, 32, 92))
$gb.FillRectangle($over, 0, 0, 640, 640)
$gb.Dispose()
$small.Dispose()
$over.Dispose()
Save-Png $bg 'theme-bg.png'
$bg.Dispose()

$app.Dispose()
$install.Dispose()
$traySrc.Dispose()
$themeSrc.Dispose()
Write-Output 'DONE'
