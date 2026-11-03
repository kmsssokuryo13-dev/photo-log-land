#Requires -Version 5.1
<#
  photo-log-land - stop local production launcher.

  Only ever terminates the server this launcher itself started and recorded
  (validated by PID + process start time + still owning port 5178). Never
  kills by process name, never touches a server started manually (e.g. via
  `npm run dev`), never touches unrelated processes on a stale/reused PID.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$state = Read-LauncherState
if (-not $state) {
    Write-LauncherMessage -Level Info -Message "launcherが記録したserverはありません。停止する対象がないため終了します。"
    exit 0
}

if (-not (Test-StateMatchesLiveProcess -State $state)) {
    Write-LauncherMessage -Level Warn -Message "記録されたserverは既に停止しているか、別processに置き換わっています（stale PID）。他のprocessには触れません。"
    Remove-LauncherState
    exit 0
}

$targetPid = [int]$state.pid
Write-LauncherMessage -Message "launcherが起動したphoto-log-land server (PID $targetPid) を停止します..."
try {
    Stop-Process -Id $targetPid -Force -ErrorAction Stop
} catch {
    Write-LauncherMessage -Level Warn -Message "process停止で例外が発生しました: $($_.Exception.Message)"
}

Start-Sleep -Milliseconds 500
$stillThere = Get-ProcessSafe -ProcessId $targetPid
$stillListening = @(Get-Port5178Listeners | Where-Object { $_.OwningProcess -eq $targetPid })
if ($stillThere -or $stillListening.Count -gt 0) {
    Write-LauncherMessage -Level Error -Message "server (PID $targetPid) の停止を確認できませんでした。手動で確認してください。"
    exit 1
}
Remove-LauncherState
Write-LauncherMessage -Level Success -Message "photo-log-land serverを停止しました（PID $targetPid）。port 5178 は解放されました。"
exit 0
