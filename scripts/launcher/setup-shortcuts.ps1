#Requires -Version 5.1
<#
  photo-log-land - create current-user Desktop shortcuts for the local
  production launcher. No admin rights required. Safe to re-run (it simply
  overwrites the two .lnk files each time).

  Only the generated .lnk files (outside the repo, on the Desktop) contain
  this machine's absolute repo path; it is never hardcoded in tracked source.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$repoRoot = Get-RepoRoot
$startScript = Join-Path $PSScriptRoot 'start.ps1'
$stopScript = Join-Path $PSScriptRoot 'stop.ps1'

if (-not (Test-Path -LiteralPath $startScript)) { throw "start.ps1 が見つかりません: $startScript" }
if (-not (Test-Path -LiteralPath $stopScript)) { throw "stop.ps1 が見つかりません: $stopScript" }

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
    throw "current userのDesktopフォルダを解決できませんでした。"
}

$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

function New-LauncherShortcut {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$TargetScript,
        [Parameter(Mandatory)][string]$Description
    )
    $shell = New-Object -ComObject WScript.Shell
    $lnkPath = Join-Path $desktop "$Name.lnk"
    $shortcut = $shell.CreateShortcut($lnkPath)
    $shortcut.TargetPath = $powershellExe
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$TargetScript`""
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = $Description
    $shortcut.WindowStyle = 7
    try {
        $shortcut.IconLocation = 'shell32.dll,220'
    } catch {
        # Icon is cosmetic only; ignore if unavailable.
    }
    $shortcut.Save()
    return $lnkPath
}

$startLnk = New-LauncherShortcut -Name '土地写真台帳' -TargetScript $startScript -Description '土地写真台帳アプリをローカルで起動します (http://localhost:5178/)'
$stopLnk = New-LauncherShortcut -Name '土地写真台帳 終了（推奨）' -TargetScript $stopScript -Description '土地写真台帳アプリのローカルserverを安全に停止します'

Write-LauncherMessage -Level Success -Message "Desktop shortcutを作成しました:"
Write-LauncherMessage -Message "  $startLnk"
Write-LauncherMessage -Message "  $stopLnk"
Write-LauncherMessage -Message "このsetupはPCごとに1回だけ実行してください。再実行しても上書きされるだけで安全です。"
exit 0
