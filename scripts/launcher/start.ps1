#Requires -Version 5.1
<#
  photo-log-land - start local production launcher.

  Same behavior as the doc-make / doc-make-land launchers (scripts/launcher/start.ps1),
  for the photo app at http://localhost:5178/ (no PDF render service):
    - If photo-log-land is already responding on http://localhost:5178/, just
      opens the browser (no duplicate server, no rebuild).
    - If port 5178 is occupied by something else, fails safely with a clear
      message; never falls back to another port or origin (the photo app's
      data lives in the browser storage of http://localhost:5178).
    - If nothing is listening, runs `npm run build` (skipped when dist is
      newer than every build input) then starts `vite preview` bound to
      localhost:5178 (loopback only, strict port), waits for readiness,
      records the server PID, then opens the browser.

  -NoBrowser: start (or confirm) the server exactly as above but do not open
  the browser. SURVIA uses this (it starts photo-log-land in the background and
  opens it itself when the user presses 写真台帳 >「土地写真台帳で開く」).
#>
param(
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

function Open-AppBrowser {
    if ($NoBrowser) { return }
    Start-Process $Script:AppTargetUrl
}

function Test-DistUpToDate {
    <#
      $true when dist\index.html exists and is newer than every build input
      (src, public, index.html, package.json, package-lock.json,
      vite.config.ts, tsconfig*.json). Never throws; any error means "rebuild".
    #>
    param([Parameter(Mandatory)][string]$RepoRoot)
    try {
        $distIndex = Join-Path $RepoRoot 'dist\index.html'
        if (-not (Test-Path -LiteralPath $distIndex)) { return $false }
        $builtAt = (Get-Item -LiteralPath $distIndex).LastWriteTimeUtc
        foreach ($name in @('src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json')) {
            $p = Join-Path $RepoRoot $name
            if (-not (Test-Path -LiteralPath $p)) { continue }
            $item = Get-Item -LiteralPath $p
            $files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $p -Recurse -File) } else { @($item) }
            foreach ($f in $files) {
                if ($f.LastWriteTimeUtc -gt $builtAt) { return $false }
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Test-DependenciesUpToDate {
    <#
      $true when node_modules was installed from the current package-lock.json
      (npm writes node_modules\.package-lock.json on every install). Never
      throws; any error means "install".
    #>
    param([Parameter(Mandatory)][string]$RepoRoot)
    try {
        $installed = Join-Path $RepoRoot 'node_modules\.package-lock.json'
        $lock = Join-Path $RepoRoot 'package-lock.json'
        if (-not (Test-Path -LiteralPath $installed)) { return $false }
        if (-not (Test-Path -LiteralPath $lock)) { return $true }
        return (Get-Item -LiteralPath $installed).LastWriteTimeUtc -ge (Get-Item -LiteralPath $lock).LastWriteTimeUtc
    } catch {
        return $false
    }
}

function Fail {
    param([string]$Message)
    Write-LauncherMessage -Level Error -Message $Message
    Show-ErrorDialogIfInteractive -Message $Message
    exit 1
}

$repoRoot = Get-RepoRoot
Write-LauncherMessage -Message "repo root: $repoRoot"

# --- 1. Node / npm availability -------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $npmCmd) {
    Fail "Node.js または npm が見つかりません。Node.js をインストールしてから再度お試しください。"
}

# --- 2. Already-running check (launcher state, then live port) ------------
$priorState = Read-LauncherState
if ($priorState) {
    if ((Test-StateMatchesLiveProcess -State $priorState) -and (Test-AppMarker)) {
        Write-LauncherMessage -Level Success -Message "既に photo-log-land が起動中です。ブラウザだけを開きます。"
        Open-AppBrowser
        exit 0
    }
    Write-LauncherMessage -Level Warn -Message "前回のserver記録が無効なため破棄します（stale PID）。"
    Remove-LauncherState
}

$listeners = @(Get-Port5178Listeners)
if ($listeners.Count -gt 0) {
    if (Test-AppMarker) {
        # 起動元processを特定できないため、pidを記録・採用しない（npm run dev 等）。
        Write-LauncherMessage -Level Success -Message "port 5178 で photo-log-land が既に応答しています。ブラウザだけを開きます。"
        Open-AppBrowser
        exit 0
    }
    $ownerPids = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Fail "port 5178 は photo-log-land ではない別のプロセス(PID: $ownerPids)に使用されています。別のportへは自動移行しません。該当プロセスを終了してから再度お試しください。"
}

# --- 3. Dependencies --------------------------------------------------------
# A git pull that adds or updates packages changes package-lock.json. Install
# them before building so the build never runs against stale node_modules.
$npmCliJs = Join-Path (Split-Path -Parent $npmCmd.Source) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-DependenciesUpToDate -RepoRoot $repoRoot)) {
    if (-not (Test-Path -LiteralPath $npmCliJs)) {
        Fail "npm-cli.js が見つかりません: $npmCliJs 。Node.js のインストールを確認してください。"
    }
    Write-LauncherMessage -Message "必要な部品が更新されたため npm install を実行します..."
    $installLog = Join-Path (Get-LauncherDataDir) 'install.log'
    $installErrLog = "$installLog.err"
    $installArgString = ('"{0}" install --no-audit --no-fund' -f $npmCliJs)
    $installProc = Start-Process -FilePath $nodeCmd.Source -ArgumentList $installArgString -WorkingDirectory $repoRoot `
        -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $installLog -RedirectStandardError $installErrLog
    if ($installProc.ExitCode -ne 0) {
        Fail "npm install に失敗しました（exit code $($installProc.ExitCode)）。詳細: $installLog / $installErrLog"
    }
    Write-LauncherMessage -Level Success -Message "npm install 成功。"
}

# --- 4. Build ---------------------------------------------------------------
# Runs `npm run build` via `node npm-cli.js run build` (Start-Process output
# redirection needs a real executable, not the npm.cmd shim). Skipped when
# dist/ is newer than every build input; any edit, git pull or npm install
# touches an input and makes the next start rebuild.
if (Test-DistUpToDate -RepoRoot $repoRoot) {
    Write-LauncherMessage -Message "build済みの dist が最新のため build を省略します。"
} else {
    Write-LauncherMessage -Message "server未起動のため production build を実行します..."
    if (-not (Test-Path -LiteralPath $npmCliJs)) {
        Fail "npm-cli.js が見つかりません: $npmCliJs 。Node.js のインストールを確認してください。"
    }
    $buildLog = Get-BuildLogPath
    $buildErrLog = "$buildLog.err"
    # Start-Process -ArgumentList does not auto-quote elements containing
    # spaces, so path-shaped arguments are quoted explicitly.
    $buildArgString = ('"{0}" run build' -f $npmCliJs)
    $buildProc = Start-Process -FilePath $nodeCmd.Source -ArgumentList $buildArgString -WorkingDirectory $repoRoot `
        -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $buildLog -RedirectStandardError $buildErrLog
    if ($buildProc.ExitCode -ne 0) {
        Fail "npm run build に失敗しました（exit code $($buildProc.ExitCode)）。詳細: $buildLog / $buildErrLog"
    }
    Write-LauncherMessage -Level Success -Message "build成功。"
}

# --- 5. Launch preview server (direct node invocation: exact, killable PID) -
$viteJs = Join-Path $repoRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $viteJs)) {
    Fail "vite が見つかりません: $viteJs 。npm install を確認してください。"
}

$outLog = Get-PreviewOutLogPath
$errLog = Get-PreviewErrLogPath
'' | Set-Content -LiteralPath $outLog -Encoding UTF8
'' | Set-Content -LiteralPath $errLog -Encoding UTF8

$previewArgString = ('"{0}" preview --host localhost --port {1} --strictPort' -f $viteJs, $Script:AppPort)
$proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList $previewArgString -WorkingDirectory $repoRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

Write-LauncherMessage -Message "preview server起動中 (PID $($proc.Id))。readiness確認中..."

if (-not (Wait-ForAppReady -TimeoutSeconds 25)) {
    Write-LauncherMessage -Level Error -Message "readiness確認がtimeoutしました。起動したserverを停止します。"
    try {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    } catch {}
    Fail "photo-log-land の起動確認に失敗しました。誤ったURLは開きません。ログ: $outLog / $errLog"
}

# Re-fetch the process object for an accurate StartTime snapshot.
$liveProc = Get-ProcessSafe -ProcessId $proc.Id
if (-not $liveProc) {
    Fail "起動直後にserver processが見つかりませんでした。"
}

Write-LauncherState -RepoRoot $repoRoot -App ([pscustomobject]@{
    pid       = $liveProc.Id
    port      = $Script:AppPort
    startedAt = $liveProc.StartTime.ToString('o')
})

Write-LauncherMessage -Level Success -Message "photo-log-land が起動しました: $($Script:AppTargetUrl) (PID $($liveProc.Id))"
Open-AppBrowser
exit 0
