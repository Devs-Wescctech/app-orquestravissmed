# Kill processes on specific ports for VisMed
param(
    [int[]]$Ports = @(3333, 3005, 3000, 3001)
)

foreach ($port in $Ports) {
    Write-Host "Checking port $port..." -ForegroundColor Cyan
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            $procId = $conn.OwningProcess
            try {
                $procName = (Get-Process -Id $procId).Name
                if ($procName -match "docker" -or $procName -match "wslrelay" -or $procName -match "Docker Desktop") {
                    Write-Host "Skipping Docker process $procName (PID: $procId) on port $port to prevent crash" -ForegroundColor DarkGray
                    continue
                }
                Write-Host "Killing process $procName (PID: $procId) on port $port" -ForegroundColor Yellow
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
            catch {
                Write-Host "Could not kill PID $procId" -ForegroundColor Red
            }
        }
    }
}

# Clean Next.js cache
Write-Host "Cleaning Next.js cache..." -ForegroundColor Cyan
if (Test-Path "apps/web/.next") {
    Remove-Item -Path "apps/web/.next" -Recurse -Force -ErrorAction SilentlyContinue
}

# Restart services
Write-Host "Starting API and Web services..." -ForegroundColor Green
# Using background processes - IMPORTANT: Use npm.cmd on Windows to avoid %1 is not a valid Win32 app error
Start-Process npm.cmd -ArgumentList "run dev:api" -NoNewWindow
Start-Process npm.cmd -ArgumentList "run dev:web" -NoNewWindow

Write-Host "Environment reboot initiated successfully." -ForegroundColor Green
