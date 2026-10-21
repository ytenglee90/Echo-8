[CmdletBinding()]
param([switch]$KeepPairing)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:LOCALAPPDATA 'NovelForge\CanvasConnector'
$statusFile = Join-Path $stateRoot 'status.json'
if (Test-Path -LiteralPath $statusFile -PathType Leaf) {
    try {
        $status = Get-Content -Raw -LiteralPath $statusFile | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$status.connectorPid)" -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -like '*novelforge_connector.py*') {
            Stop-Process -Id $process.ProcessId -Force
        }
    } catch {
        Write-Warning "Could not stop the existing connector automatically: $($_.Exception.Message)"
    }
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'NovelForge Canvas Connector.lnk'
if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
if (-not $KeepPairing -and (Test-Path -LiteralPath $stateRoot)) {
    $resolved = (Resolve-Path -LiteralPath $stateRoot).Path
    $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NovelForge\CanvasConnector'))
    if ($resolved -ne $expected) { throw 'Refusing to remove an unexpected connector directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

@{ status = 'UNINSTALLED'; pairing_retained = [bool]$KeepPairing } | ConvertTo-Json
