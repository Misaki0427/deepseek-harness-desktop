param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [string]$Lang = 'chi_sim+eng',
    [int]$Psm = 3
)

# 本地 OCR（第一层：免费、离线、纯文字图片约 2-3 秒）
# 用法：  .\tools\ocr-image.ps1 -ImagePath 图片路径

$ErrorActionPreference = 'Stop'

if (-not (Get-Command tesseract -ErrorAction SilentlyContinue)) {
    Write-Host '未安装 Tesseract，请先执行：'
    Write-Host '  winget install UB-Mannheim.TesseractOCR'
    Write-Host '  （安装向导中勾选 Additional language: Chinese Simplified）'
    exit 1
}

& tesseract $ImagePath stdout -l $Lang --psm $Psm
