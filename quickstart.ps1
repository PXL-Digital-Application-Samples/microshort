Write-Host "Starting microshort services..." -ForegroundColor Green

# Start services
docker compose up -d

# Wait for services to be ready
Write-Host "`nWaiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Check health
Write-Host "`nChecking service health:" -ForegroundColor Cyan
try {
    $null = Invoke-RestMethod -Uri "http://localhost:3000/health" -Method Get
    Write-Host " ✓ Config service is healthy" -ForegroundColor Green
} catch {
    Write-Host " ✗ Config service is not ready" -ForegroundColor Red
}

try {
    $null = Invoke-RestMethod -Uri "http://localhost:3001/health" -Method Get
    Write-Host " ✓ Auth service is healthy" -ForegroundColor Green
} catch {
    Write-Host " ✗ Auth service is not ready" -ForegroundColor Red
}

Write-Host "`nServices are running!" -ForegroundColor Green
Write-Host "Config service: http://localhost:3000/docs"
Write-Host "Auth service: http://localhost:3001"

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