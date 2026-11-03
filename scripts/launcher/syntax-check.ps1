#Requires -Version 5.1
<#
  photo-log-land - launcher-only syntax check.

  Parses every launcher PowerShell script with the PowerShell language
  parser (no execution) and fails if any file has a parse error. It does not
  touch vitest / src, since the launcher is operational tooling only.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launcher\syntax-check.ps1
  Exit code 0 = all files parse cleanly. Non-zero = at least one failure.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$targets = @('common.ps1', 'start.ps1', 'stop.ps1', 'setup-shortcuts.ps1', 'syntax-check.ps1')
$hadError = $false

foreach ($name in $targets) {
    $path = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "[ERROR] file not found: $path" -ForegroundColor Red
        $hadError = $true
        continue
    }
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $hadError = $true
        Write-Host "[ERROR] parse errors in $name :" -ForegroundColor Red
        foreach ($e in $errors) {
            Write-Host ("    line $($e.Extent.StartLineNumber): $($e.Message)") -ForegroundColor Red
        }
    } else {
        Write-Host "[OK] $name parses cleanly" -ForegroundColor Green
    }
}

if ($hadError) {
    Write-Host "[RESULT] syntax check FAILED" -ForegroundColor Red
    exit 1
} else {
    Write-Host "[RESULT] syntax check PASSED ($($targets.Count) files)" -ForegroundColor Green
    exit 0
}
