# Stops any running Mini Screen agent and starts it again in the background.
$root = (Resolve-Path "$PSScriptRoot\..").Path
$port = (Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json).port
if (-not $port) { $port = 8765 }

# The venv's pythonw.exe is a launcher that spawns the real interpreter, so stop
# whatever owns the port plus any launcher still running from this project's venv.
$pids = @()
$pids += Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
$pids += Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
    Where-Object { $_.CommandLine -match '-m agent' -and $_.ExecutablePath -like "$root\.venv\*" } |
    Select-Object -ExpandProperty ProcessId
foreach ($id in ($pids | Sort-Object -Unique)) {
    try { Stop-Process -Id $id -Force -ErrorAction Stop; "Stopped PID $id" } catch {}
}
Start-Sleep -Milliseconds 800

if (Get-ScheduledTask -TaskName 'MiniScreen Agent' -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName 'MiniScreen Agent'
    "Started via scheduled task"
} else {
    Start-Process -FilePath (Join-Path $root '.venv\Scripts\pythonw.exe') -ArgumentList '-m', 'agent' -WorkingDirectory $root -WindowStyle Hidden
    "Started in background"
}
