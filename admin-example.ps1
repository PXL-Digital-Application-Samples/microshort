# Admin Example - Shows how to use admin service
Write-Host "=== Admin Service Demo ===" -ForegroundColor Cyan

# First, we need to get an admin API key (user ID 1)
Write-Host "`n1. Creating admin user (first user is admin)..." -ForegroundColor Yellow

# Register admin if not exists
try {
    $adminReg = Invoke-RestMethod -Uri "http://localhost:3001/auth/register" `
        -Method Post `
        -ContentType "application/json" `
        -Body '{"email":"admin@microshort.com","password":"admin123"}'
    
    $adminToken = $adminReg.token
    Write-Host "✓ Admin user created" -ForegroundColor Green
} catch {
    # If user exists, login instead
    Write-Host "Admin exists, logging in..." -ForegroundColor Gray
    $adminLogin = Invoke-RestMethod -Uri "http://localhost:3001/auth/login" `
        -Method Post `
        -ContentType "application/json" `
        -Body '{"email":"admin@microshort.com","password":"admin123"}'
    
    $adminToken = $adminLogin.token
}

# Generate admin API key
Write-Host "`n2. Generating admin API key..." -ForegroundColor Yellow
$adminKeyResponse = Invoke-RestMethod -Uri "http://localhost:3001/auth/api-keys" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{Authorization="Bearer $adminToken"} `
    -Body '{"name":"Admin Key"}'

$adminApiKey = $adminKeyResponse.apiKey
Write-Host "✓ Admin API key: $adminApiKey" -ForegroundColor Green

# Create some test data
Write-Host "`n3. Creating test data..." -ForegroundColor Yellow

# Create a regular user
try {
    $userReg = Invoke-RestMethod -Uri "http://localhost:3001/auth/register" `
        -Method Post `
        -ContentType "application/json" `
        -Body '{"email":"user@example.com","password":"user123"}'
    
    # Get API key for regular user
    $userKeyResponse = Invoke-RestMethod -Uri "http://localhost:3001/auth/api-keys" `
        -Method Post `
        -ContentType "application/json" `
        -Headers @{Authorization="Bearer $($userReg.token)"} `
        -Body '{"name":"User Key"}'
    
    $userApiKey = $userKeyResponse.apiKey
    
    # Create some URLs
    1..3 | ForEach-Object {
        Invoke-RestMethod -Uri "http://localhost:3002/urls" `
            -Method Post `
            -Headers @{"X-API-Key"=$userApiKey} `
            -ContentType "application/json" `
            -Body "{`"url`":`"https://example.com/page$_`"}" | Out-Null
    }
    
    Write-Host "✓ Created test user and URLs" -ForegroundColor Green
} catch {
    Write-Host "Test data already exists" -ForegroundColor Gray
}

# Now use admin service
Write-Host "`n4. Testing admin endpoints..." -ForegroundColor Yellow

# Dashboard
Write-Host "`n  a) Dashboard:" -ForegroundColor Cyan
$dashboard = Invoke-RestMethod -Uri "http://localhost:3003/admin/dashboard" `
    -Headers @{"X-API-Key"=$adminApiKey}

Write-Host "     Total users: $($dashboard.users.total)"
Write-Host "     Total URLs: $($dashboard.urls.total)"
Write-Host "     Total clicks: $($dashboard.urls.totalClicks)"

# List users
Write-Host "`n  b) All users:" -ForegroundColor Cyan
$users = Invoke-RestMethod -Uri "http://localhost:3003/admin/users" `
    -Headers @{"X-API-Key"=$adminApiKey}

$users.users | ForEach-Object {
    Write-Host "     - $($_.email) (ID: $($_.id))"
}

# List URLs
Write-Host "`n  c) Recent URLs:" -ForegroundColor Cyan
$urls = Invoke-RestMethod -Uri "http://localhost:3003/admin/urls" `
    -Headers @{"X-API-Key"=$adminApiKey}

$urls.urls | Select-Object -First 5 | ForEach-Object {
    Write-Host "     - $($_.slug) → $($_.longUrl.Substring(0, [Math]::Min(40, $_.longUrl.Length)))..."
}

# Service health
Write-Host "`n  d) Service health:" -ForegroundColor Cyan
$health = Invoke-RestMethod -Uri "http://localhost:3003/admin/health/services" `
    -Headers @{"X-API-Key"=$adminApiKey}

$health.services | ForEach-Object {
    $color = if ($_.status -eq "healthy") { "Green" } else { "Red" }
    Write-Host "     - $($_.service): $($_.status)" -ForegroundColor $color
}

Write-Host "`n=== Admin Demo Complete! ===" -ForegroundColor Cyan
Write-Host "Admin API key saved for future use: $adminApiKey" -ForegroundColor Yellow
Write-Host "Admin service URL: http://localhost:3003" -ForegroundColor Yellow
