param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [string]$Lang = 'chi_sim+eng',
    [int]$Psm = 3
)

# 本地 OCR（免费、离线、纯文字图片约 2-3 秒）
# 用法：  .\tools\ocr-image.ps1 -ImagePath 图片路径

$ErrorActionPreference = 'Stop'

# 1. 定位 tesseract（PATH 或标准安装位置）
$tesseract = (Get-Command tesseract -ErrorAction SilentlyContinue).Source
if (-not $tesseract) {
    $candidate = 'C:\Program Files\Tesseract-OCR\tesseract.exe'
    if (Test-Path $candidate) { $tesseract = $candidate }
    else {
        Write-Host '未安装 Tesseract，请先执行： winget install UB-Mannheim.TesseractOCR'
        exit 1
    }
}

# 2. 准备本地语言包目录（免管理员权限）
$localTessdata = Join-Path $PSScriptRoot 'tessdata'
New-Item -ItemType Directory -Force $localTessdata | Out-Null

if (-not (Test-Path (Join-Path $localTessdata 'chi_sim.traineddata'))) {
    Write-Host '[提示] 未找到中文语言包，仅英文识别。下载 chi_sim.traineddata 放入 tools\tessdata\'
}

# eng 是组合语言的基础，缺失时自动从系统 tessdata 复制
$sysTessdata = 'C:\Program Files\Tesseract-OCR\tessdata'
if (-not (Test-Path (Join-Path $localTessdata 'eng.traineddata'))) {
    if (Test-Path (Join-Path $sysTessdata 'eng.traineddata')) {
        Copy-Item (Join-Path $sysTessdata 'eng.traineddata') $localTessdata -Force
    }
}
if (-not (Test-Path (Join-Path $localTessdata 'osd.traineddata'))) {
    if (Test-Path (Join-Path $sysTessdata 'osd.traineddata')) {
        Copy-Item (Join-Path $sysTessdata 'osd.traineddata') $localTessdata -Force
    }
}

# 3. 执行 OCR
& $tesseract $ImagePath stdout -l $Lang --psm $Psm --tessdata-dir $localTessdata
