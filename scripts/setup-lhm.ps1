# Run elevated (once). Makes LibreHardwareMonitor start minimized to the tray
# at every logon with admin rights, so PixelDeck can read CPU temperature.
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$User,
    [string]$Log = "$PSScriptRoot\..\logs\setup-lhm.log"
)
$ErrorActionPreference = 'Stop'
Start-Transcript -Path $Log -Force | Out-Null
try {
    $dir = Split-Path $Exe
    $cfg = Join-Path $dir 'LibreHardwareMonitor.config'
    if (-not (Test-Path $cfg)) {
        @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="startMinMenuItem" value="true" />
    <add key="minTrayMenuItem" value="true" />
    <add key="minCloseMenuItem" value="true" />
  </appSettings>
</configuration>
'@ | Set-Content -Path $cfg -Encoding UTF8
        "Wrote $cfg"
    }

    $name = 'PixelDeck - LibreHardwareMonitor'
    $action = New-ScheduledTaskAction -Execute $Exe -WorkingDirectory $dir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description 'Starts LibreHardwareMonitor for PixelDeck' -Force | Out-Null
    "Registered task '$name'"

    if (-not (Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue)) {
        Start-ScheduledTask -TaskName $name
        "Started LibreHardwareMonitor"
    }
    "OK"
} catch {
    "FAILED: $_"
} finally {
    Stop-Transcript | Out-Null
}
