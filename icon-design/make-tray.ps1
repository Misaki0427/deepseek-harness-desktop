Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function New-Glyph([int]$size) {
    $k = $size / 128.0
    function F([double]$v) { return $v * $k }

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    function Brush([int]$a, [int]$r, [int]$gr, [int]$b) {
        New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, $r, $gr, $b))
    }

    # ---------- whale tail behind head ----------
    $tail = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tail.StartFigure()
    $tail.AddBezier((F 64), (F 46), (F 48), (F 20), (F 26), (F 6), (F 10), (F 18))
    $tail.AddBezier((F 10), (F 18), (F 26), (F 34), (F 44), (F 40), (F 64), (F 46))
    $tail.CloseFigure()
    $tail.StartFigure()
    $tail.AddBezier((F 64), (F 46), (F 80), (F 20), (F 102), (F 6), (F 118), (F 18))
    $tail.AddBezier((F 118), (F 18), (F 102), (F 34), (F 84), (F 40), (F 64), (F 46))
    $tail.CloseFigure()
    $tailBrush = Brush 255 53 88 232
    $g.FillPath($tailBrush, $tail)
    $tail.Dispose()
    $tailBrush.Dispose()

    # ---------- head circle with gradient ----------
    $headRect = New-Object System.Drawing.Rectangle([int](12 * $k), [int](26 * $k), [int](104 * $k), [int](104 * $k))
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $headRect,
        [System.Drawing.Color]::FromArgb(255, 105, 139, 255),
        [System.Drawing.Color]::FromArgb(255, 58, 92, 232),
        90.0)
    $g.FillEllipse($grad, (F 12), (F 26), (F 104), (F 104))
    $grad.Dispose()

    # ---------- white belly crescent (clipped) ----------
    $circ = New-Object System.Drawing.Drawing2D.GraphicsPath
    $circ.AddEllipse((F 12), (F 26), (F 104), (F 104))
    $g.SetClip($circ)
    $white = Brush 255 255 255 255
    $g.FillEllipse($white, (F 30), (F 92), (F 68), (F 52))
    $g.ResetClip()
    $circ.Dispose()

    # ---------- maid headdress band + frills ----------
    $band = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 26 * $k
    $band.AddArc((F 30), (F 20), $d, $d, 180, 90)
    $band.AddArc((F 30) + (F 68) - $d, (F 20), $d, $d, 270, 90)
    $band.AddArc((F 30) + (F 68) - $d, (F 20) + (F 26) - $d, $d, $d, 0, 90)
    $band.AddArc((F 30), (F 20) + (F 26) - $d, $d, $d, 90, 90)
    $band.CloseFigure()
    $g.FillPath($white, $band)
    $band.Dispose()
    $g.FillEllipse($white, (F 32), (F 8), (F 20), (F 20))
    $g.FillEllipse($white, (F 54), (F 4), (F 20), (F 20))
    $g.FillEllipse($white, (F 76), (F 8), (F 20), (F 20))

    # ---------- eyes ----------
    $navy = Brush 255 27 42 94
    $g.FillEllipse($navy, (F 39), (F 65), (F 14), (F 14))
    $g.FillEllipse($navy, (F 75), (F 65), (F 14), (F 14))
    $hl = Brush 255 255 255 255
    $g.FillEllipse($hl, (F 43), (F 68), (F 5), (F 5))
    $g.FillEllipse($hl, (F 79), (F 68), (F 5), (F 5))
    $navy.Dispose()

    # ---------- blush ----------
    $blush = Brush 210 255 143 160
    $g.FillEllipse($blush, (F 26), (F 88), (F 13), (F 8))
    $g.FillEllipse($blush, (F 89), (F 88), (F 13), (F 8))
    $blush.Dispose()

    # ---------- mouth ----------
    $mp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 214, 120, 100), (F 4))
    $mp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $mp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($mp, (F 55), (F 86), (F 18), (F 14), 20, 140)
    $mp.Dispose()

    $white.Dispose()
    $hl.Dispose()
    $g.Dispose()
    return $bmp
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

$t32 = New-Glyph 32
Save-Png $t32 'tray.png'
$t32.Dispose()

$t16 = New-Glyph 16
Save-Png $t16 'tray-16.png'
$t16.Dispose()

$preview = New-Glyph 256
Save-Png $preview 'tray-preview.png'
$preview.Dispose()

Write-Output 'DONE'
