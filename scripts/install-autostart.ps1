# Starts the PixelDeck agent in the background every time you log in to Windows,
# and starts it again within 2 minutes if it ever stops (a crash, or being killed).
# No admin rights needed. Undo with scripts\uninstall-autostart.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
$pythonw = Join-Path $root '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $pythonw)) { throw "Missing $pythonw - create the venv first (see README)." }

$name = 'PixelDeck Agent'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $pythonw -Argument '-m agent' -WorkingDirectory $root
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT15S'
# Watchdog: fire every 2 minutes, forever. While the agent runs this does nothing
# (MultipleInstances IgnoreNew below); if it has died, this starts it again.
# The task's own "restart on failure" doesn't cover a crash after a successful start.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $watchdog) -Principal $principal `
    -Settings $settings -Description 'PixelDeck: streams PC stats to the phone over USB' -Force | Out-Null
"Registered '$name' (runs at logon, and restarts the agent within 2 minutes if it stops)."
