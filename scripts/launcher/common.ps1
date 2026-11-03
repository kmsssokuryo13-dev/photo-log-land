#Requires -Version 5.1
<#
  photo-log-land local production launcher - shared helpers.
  Same design as the doc-make / doc-make-land launchers (scripts/launcher),
  adapted to the land photo ledger app: http://localhost:5178/ only, app server only
  (no PDF render service), separate state directory.
  Loopback-only, current-user-only, no admin rights, no LAN exposure.
  This file resolves all paths at runtime from $PSScriptRoot; it must never
  contain a machine-specific absolute path baked in as a literal.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:AppTargetUrl = 'http://localhost:5178/'
$Script:AppPort = 5178
# ASCII-only marker by design: Windows PowerShell 5.1's Invoke-WebRequest
# decodes the response body using a Latin-1-ish fallback encoding whenever
# the server's Content-Type header omits charset (as vite preview's does),
# so the Japanese <title> cannot be used. index.html carries
# <meta name="app-id" content="photo-log-land"> for this purpose
# (SURVIA checks the same marker).
$Script:AppMarker = 'content="photo-log-land"'

function Get-RepoRoot {
    # scripts/launcher/common.ps1 -> repo root is two levels up.
    $launcherDir = $PSScriptRoot
    $scriptsDir = Split-Path -Parent $launcherDir
    return (Split-Path -Parent $scriptsDir)
}

function Get-LauncherDataDir {
    $dir = Join-Path $env:LOCALAPPDATA 'photo-log-land-launcher'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Get-StateFilePath { return (Join-Path (Get-LauncherDataDir) 'state.json') }
function Get-BuildLogPath { return (Join-Path (Get-LauncherDataDir) 'build.log') }
function Get-PreviewOutLogPath { return (Join-Path (Get-LauncherDataDir) 'preview.out.log') }
function Get-PreviewErrLogPath { return (Join-Path (Get-LauncherDataDir) 'preview.err.log') }

function Read-LauncherState {
    $path = Get-StateFilePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        # Corrupt/unreadable state file: treat as absent rather than fail hard.
        return $null
    }
}

function Write-LauncherState {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)]$App # @{ pid; port; startedAt }
    )
    $state = [ordered]@{
        version   = 1
        launcher  = 'photo-log-land-local-production-launcher-v1'
        repoRoot  = $RepoRoot
        pid       = $App.pid
        port      = $App.port
        startedAt = $App.startedAt
    }
    ($state | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Get-StateFilePath) -Encoding UTF8
}

function Remove-LauncherState {
    $path = Get-StateFilePath
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Get-PortListeners {
    param([Parameter(Mandatory)][int]$Port)
    # Only entries actually in Listen state; ignores TIME_WAIT etc.
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-Port5178Listeners {
    return @(Get-PortListeners -Port $Script:AppPort)
}

function Test-AppMarker {
    <#
      Confirms the response at the target URL is photo-log-land itself (not
      some unrelated service that happens to occupy the port). Never throws;
      returns $false on any connection/parse failure.
    #>
    try {
        $resp = Invoke-WebRequest -Uri $Script:AppTargetUrl -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 5 -ErrorAction Stop
        if ($resp.StatusCode -ne 200) { return $false }
        return ($resp.Content -like "*$($Script:AppMarker)*")
    } catch {
        return $false
    }
}

function Wait-ForAppReady {
    param(
        [int]$TimeoutSeconds = 20,
        [int]$IntervalMilliseconds = 500
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-AppMarker) { return $true }
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    return $false
}

function Get-ProcessSafe {
    param([Parameter(Mandatory)][int]$ProcessId)
    try {
        return (Get-Process -Id $ProcessId -ErrorAction Stop)
    } catch {
        return $null
    }
}

function Test-StateMatchesLiveProcess {
    <#
      Defends against PID reuse: the recorded PID must (a) currently exist,
      (b) have the exact recorded start time, and (c) still own the
      listening socket on port 5178. All three must match before stop.ps1
      is allowed to terminate it.
    #>
    param([Parameter(Mandatory)]$State)

    if ($null -eq $State) { return $false }
    if (-not ($State.PSObject.Properties.Name -contains 'pid') -or $null -eq $State.pid) { return $false }

    $proc = Get-ProcessSafe -ProcessId ([int]$State.pid)
    if ($null -eq $proc) { return $false }

    $recordedStart = $null
    try { $recordedStart = [DateTime]::Parse($State.startedAt, [System.Globalization.CultureInfo]::InvariantCulture) } catch { return $false }

    $actualStart = $null
    try { $actualStart = $proc.StartTime } catch { return $false }

    if (-not $actualStart) { return $false }
    if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 2) { return $false }

    $ownsPort = @(Get-Port5178Listeners | Where-Object { $_.OwningProcess -eq [int]$State.pid })
    if ($ownsPort.Count -eq 0) { return $false }

    return $true
}

function Write-LauncherMessage {
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('Info', 'Success', 'Warn', 'Error')][string]$Level = 'Info'
    )
    $prefix = switch ($Level) {
        'Success' { '[OK] ' }
        'Warn'    { '[WARN] ' }
        'Error'   { '[ERROR] ' }
        default   { '[INFO] ' }
    }
    $color = switch ($Level) {
        'Success' { 'Green' }
        'Warn'    { 'Yellow' }
        'Error'   { 'Red' }
        default   { 'Gray' }
    }
    Write-Host "$prefix$Message" -ForegroundColor $color
}

function Show-ErrorDialogIfInteractive {
    <#
      start.ps1/stop.ps1 are normally launched hidden (Desktop shortcut or
      SURVIA), so console output is invisible to the user. On failure we
      also show a simple message box.
    #>
    param([Parameter(Mandatory)][string]$Message)
    # Escape hatch for unattended verification runs only.
    if ($env:PHOTO_LOG_LAUNCHER_TEST_MODE -eq '1') { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show($Message, '土地写真台帳 - 起動ランチャー', 'OK', 'Error') | Out-Null
    } catch {
        # Best-effort only; console output above remains the source of truth.
    }
}
