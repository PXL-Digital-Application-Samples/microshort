# Wait for microshort services to be ready
param(
    [int]$MaxAttempts = 30,
    [int]$DelaySeconds = 2
)

Write-Host "Waiting for services to be ready..." -ForegroundColor Yellow

$services = @(
    @{Name="Config Service"; Url="http://localhost:3000/health"},
    @{Name="Auth Service"; Url="http://localhost:3001/health"},
    @{Name="URL Service"; Url="http://localhost:3002/health"},
    @{Name="Redirect Service"; Url="http://localhost:8080/health"},
    @{Name="Admin Service"; Url="http://localhost:3003/health"}
)

foreach ($service in $services) {
    $attempts = 0
    $ready = $false
    
    Write-Host "Checking $($service.Name)..." -NoNewline
    
    while (-not $ready -and $attempts -lt $MaxAttempts) {
        try {
            $response = Invoke-WebRequest -Uri $service.Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $ready = $true
                Write-Host " ✓" -ForegroundColor Green
            }
        } catch {
            Write-Host "." -NoNewline
            Start-Sleep -Seconds $DelaySeconds
            $attempts++
        }
    }
    
    if (-not $ready) {
        Write-Host " ✗" -ForegroundColor Red
        Write-Host "Service $($service.Name) failed to start" -ForegroundColor Red
    }
}

Write-Host "`nAll services ready!" -ForegroundColor Green