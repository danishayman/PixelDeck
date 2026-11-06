# Removes the logon tasks created for the Mini Screen.
foreach ($name in 'MiniScreen Agent', 'MiniScreen - LibreHardwareMonitor') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        "Removed '$name'"
    }
}
