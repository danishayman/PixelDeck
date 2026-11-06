# Removes the logon tasks created for PixelDeck.
foreach ($name in 'PixelDeck Agent', 'PixelDeck - LibreHardwareMonitor') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        "Removed '$name'"
    }
}
