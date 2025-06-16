Write-Host "Starting microshort services..." -ForegroundColor Green

# Start services
docker compose up -d

# Wait for databases to initialize
Write-Host "`nWaiting for databases to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 20

# Wait for services to be ready with retries
Write-Host "Waiting for services to start..." -ForegroundColor Yellow
$maxAttempts = 30
$services = @(
    @{Name="Config"; Port=3000},
    @{Name="Auth"; Port=3001},
    @{Name="URL"; Port=3002},
    @{Name="Redirect"; Port=8080},
    @{Name="Admin"; Port=3003}
)

foreach ($service in $services) {
    $attempts = 0
    $ready = $false
    
    while (-not $ready -and $attempts -lt $maxAttempts) {
        try {
            $null = Invoke-RestMethod -Uri "http://localhost:$($service.Port)/health" -Method Get -TimeoutSec 2
            $ready = $true
            Write-Host " ✓ $($service.Name) service is healthy" -ForegroundColor Green
        } catch {
            $attempts++
            if ($attempts -ge $maxAttempts) {
                Write-Host " ✗ $($service.Name) service failed to start" -ForegroundColor Red
            } else {
                Start-Sleep -Seconds 2
            }
        }
    }
}

Write-Host "`nServices are running!" -ForegroundColor Green
Write-Host "Config service: http://localhost:3000/docs"
Write-Host "Auth service: http://localhost:3001"
Write-Host "URL service: http://localhost:3002"
Write-Host "Redirect service: http://localhost:8080 (public-facing)"
Write-Host "Admin service: http://localhost:3003"

Write-Host "`nTo test auth service:" -ForegroundColor Cyan
Write-Host "1. Register a user:" -ForegroundColor Yellow
Write-Host @"
   `$response = Invoke-RestMethod -Uri "http://localhost:3001/auth/register" ``
     -Method Post ``
     -ContentType "application/json" ``
     -Body '{"email":"test@example.com","password":"test123"}'
   
   # Display full token
   `$response.token
"@

Write-Host "`n2. Login:" -ForegroundColor Yellow
Write-Host @"
   `$login = Invoke-RestMethod -Uri "http://localhost:3001/auth/login" ``
     -Method Post ``
     -ContentType "application/json" ``
     -Body '{"email":"test@example.com","password":"test123"}'
   
   # Save token
   `$token = `$login.token
"@

Write-Host "`n3. Generate API Key (using saved token):" -ForegroundColor Yellow
Write-Host @"
   Invoke-RestMethod -Uri "http://localhost:3001/auth/api-keys" ``
     -Method Post ``
     -ContentType "application/json" ``
     -Headers @{Authorization="Bearer `$token"} ``
     -Body '{"name":"Development Key"}'
"@

Write-Host "`nUseful commands:" -ForegroundColor Cyan
Write-Host "Stop services: docker compose down"
Write-Host "View logs: docker compose logs -f"
Write-Host "Rebuild: docker compose up --build -d"