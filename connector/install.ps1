[CmdletBinding()]
param(
    [string]$EngineRoot = '',
    [string[]]$CanvasOrigin = @('http://localhost:3000'),
    [ValidateRange(1, 65535)][int]$Port = 32147,
    [switch]$RotateToken,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    $EngineRoot = Join-Path $PSScriptRoot '..\..\..\NovelForge-Engine'
}
$enginePath = (Resolve-Path -LiteralPath $EngineRoot).Path
$pythonw = Join-Path $enginePath '.venv\Scripts\pythonw.exe'
$connectorScript = Join-Path $PSScriptRoot 'novelforge_connector.py'
if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) {
    throw "NovelForge Engine is not installed. Run $enginePath\scripts\install.ps1 first."
}
if (-not (Test-Path -LiteralPath $connectorScript -PathType Leaf)) {
    throw "Connector program is missing: $connectorScript"
}

$normalizedOrigins = @()
foreach ($originText in $CanvasOrigin) {
    $uri = [Uri]$originText
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or
        -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or
        $uri.AbsolutePath -ne '/') {
        throw "CanvasOrigin must be a complete HTTP(S) origin without path/query/fragment: $originText"
    }
    $normalizedOrigins += $uri.GetLeftPart([System.UriPartial]::Authority)
}
$normalizedOrigins = @($normalizedOrigins | Sort-Object -Unique)
if ($normalizedOrigins.Count -eq 0) { throw 'At least one CanvasOrigin is required.' }

$stateRoot = Join-Path $env:LOCALAPPDATA 'NovelForge\CanvasConnector'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$tokenFile = Join-Path $stateRoot 'pairing.token'
$configFile = Join-Path $stateRoot 'config.json'
$statusFile = Join-Path $stateRoot 'status.json'
$logFile = Join-Path $stateRoot 'connector.log'

if ($RotateToken -or -not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.File]::WriteAllText($tokenFile, $token, [Text.Encoding]::ASCII)
} else {
    $token = [IO.File]::ReadAllText($tokenFile, [Text.Encoding]::ASCII).Trim()
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$fileSecurity = New-Object Security.AccessControl.FileSecurity
$fileSecurity.SetOwner($identity.User)
$fileSecurity.SetAccessRuleProtection($true, $false)
$fileSecurity.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $identity.User, 'FullControl', 'Allow'
)))
$fileSecurity.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), 'FullControl', 'Allow'
)))
Set-Acl -LiteralPath $tokenFile -AclObject $fileSecurity

$configuration = [ordered]@{
    version = 1
    engineRoot = $enginePath
    canvasOrigins = $normalizedOrigins
    port = $Port
    tokenFile = $tokenFile
    statusFile = $statusFile
    logFile = $logFile
}
[IO.File]::WriteAllText(
    $configFile,
    ($configuration | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
)

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'NovelForge Canvas Connector.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonw
$shortcut.Arguments = "`"$connectorScript`" --config `"$configFile`""
$shortcut.WorkingDirectory = $enginePath
$shortcut.WindowStyle = 7
$shortcut.Description = 'NovelForge Canvas local Runtime and Codex connector'
$shortcut.Save()

if (-not $NoStart) {
    Start-Process -FilePath $pythonw -ArgumentList @(
        "`"$connectorScript`"", '--config', "`"$configFile`""
    ) -WorkingDirectory $enginePath -WindowStyle Hidden
    Start-Sleep -Milliseconds 1200
}

[ordered]@{
    status = 'INSTALLED'
    endpoint = "http://127.0.0.1:$Port"
    pairing_token = $token
    canvas_origins = $normalizedOrigins
    startup_shortcut = $shortcutPath
    message = 'Paste pairing_token into the NovelForge panel once. Keep it private.'
} | ConvertTo-Json -Depth 4
