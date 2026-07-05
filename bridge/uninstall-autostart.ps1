# Removes the Claude Usage Bridge auto-start Scheduled Task and its launcher.
# Usage:  ./uninstall-autostart.ps1 [-TaskName "ClaudeUsageBridge"]
param(
    [string]$TaskName = "ClaudeUsageBridge"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath = Join-Path $scriptDir "run-hidden.vbs"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
} else {
    Write-Host "No scheduled task named '$TaskName' found." -ForegroundColor Yellow
}

if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Host "Removed launcher: $vbsPath" -ForegroundColor DarkGray
}

Write-Host "Note: a bridge process started by the task may still be running until next logoff." -ForegroundColor DarkGray
