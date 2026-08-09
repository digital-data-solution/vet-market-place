# ─────────────────────────────────────────────────────────────────────────────
# One-command setup for the weekly Xpress Vet database backup (Windows).
#
# Registers a Scheduled Task that runs scripts/backup-mongo.mjs every Sunday at
# 12:00, backing up MongoDB to your OneDrive (synced off-machine automatically).
#
# Run once per machine (e.g. after moving to a new laptop):
#     powershell -ExecutionPolicy Bypass -File scripts\setup-backup-schedule.ps1
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'
$backend = Split-Path $PSScriptRoot -Parent
$script  = Join-Path $PSScriptRoot 'backup-mongo.mjs'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) { Write-Error "Node.js not found on PATH. Install Node, then re-run."; exit 1 }
$node = $nodeCmd.Source

$taskName = 'XpressVet Weekly DB Backup'
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $backend
$trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 12:00pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Weekly read-only MongoDB backup to OneDrive (Xpress Vet)' -Force | Out-Null

Write-Host "Scheduled task '$taskName' created: every Sunday 12:00pm."
Write-Host "Backups go to: $env:USERPROFILE\OneDrive\vetfresh-backups"
Write-Host "Run a backup now to test:  node `"$script`""
