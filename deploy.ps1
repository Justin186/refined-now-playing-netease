<#
.SYNOPSIS
    Build and deploy Refined Now Playing plugin to BetterNCM

.DESCRIPTION
    1. (optional) Run npm run build
    2. Repack the .plugin package (ZIP with main.js + manifest.json at root)
    3. Sync the BetterNCM runtime directory

.PARAMETER Build
    Run npm run build first (default: deploy existing dist/ only)

.PARAMETER BetterNCMRoot
    BetterNCM root directory (default: C:\betterncm)

.EXAMPLE
    .\deploy.ps1 -Build
    Build and deploy

.EXAMPLE
    .\deploy.ps1
    Deploy existing dist/ only
#>
param(
    [switch]$Build,
    [string]$BetterNCMRoot = "C:\betterncm"
)

$ErrorActionPreference = "Stop"

# Project root (directory of this script)
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir = Join-Path $ProjectRoot "dist"

# 1. Build
if ($Build) {
    Write-Host "==> Building..." -ForegroundColor Cyan
    Push-Location $ProjectRoot
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed (npm run build exit code $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
    Write-Host "==> Build done" -ForegroundColor Green
}

# 2. Check artifacts
$srcMain = Join-Path $DistDir "main.js"
$srcManifest = Join-Path $DistDir "manifest.json"
if (-not (Test-Path $srcMain)) { throw "Not found: $srcMain. Run 'npm run build' first." }
if (-not (Test-Path $srcManifest)) { throw "Not found: $srcManifest. Run 'npm run build' first." }

# 3. Read version and plugin name from manifest
$manifest = Get-Content $srcManifest -Raw | ConvertFrom-Json
$version = $manifest.version
$pluginName = $manifest.name
Write-Host "==> Plugin: $pluginName v$version" -ForegroundColor Cyan

# 4. Repack .plugin package
$pluginsDir = Join-Path $BetterNCMRoot "plugins"
if (-not (Test-Path $pluginsDir)) {
    Write-Warning "Plugins dir not found: $pluginsDir. Creating it."
    New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
}
$dest = Join-Path $pluginsDir "$pluginName-$version.plugin"

Write-Host "==> Packing .plugin -> $dest" -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $dest) { Remove-Item $dest -Force }
$zip = [System.IO.Compression.ZipFile]::Open($dest, 'Create')
foreach ($entry in @(
    @{ name = 'main.js';       path = $srcMain },
    @{ name = 'manifest.json'; path = $srcManifest }
)) {
    $zipEntry = $zip.CreateEntry($entry.name)
    $stream = $zipEntry.Open()
    $bytes = [System.IO.File]::ReadAllBytes($entry.path)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Dispose()
}
$zip.Dispose()

# 5. Sync runtime directory
$runtimeDir = Join-Path $BetterNCMRoot "plugins_runtime\$pluginName"
if (-not (Test-Path $runtimeDir)) {
    Write-Warning "Runtime dir not found: $runtimeDir. Creating it."
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}
Copy-Item $srcMain (Join-Path $runtimeDir "main.js") -Force
Copy-Item $srcManifest (Join-Path $runtimeDir "manifest.json") -Force

Write-Host ""
Write-Host "Deploy done! Please fully exit and restart NetEase Cloud Music." -ForegroundColor Green
Write-Host "  .plugin: $dest" -ForegroundColor Gray
Write-Host "  runtime: $runtimeDir" -ForegroundColor Gray