# Admin Service PowerShell Examples
$baseUrl = "http://localhost:3003"
$adminApiKey = "YOUR_ADMIN_API_KEY"  # Must be from user ID 1

Write-Host "=== Admin Service Examples ===" -ForegroundColor Cyan
Write-Host "Note: You need an admin API key (from user ID 1)" -ForegroundColor Yellow

# 1. Get Dashboard
Write-Host "`n1. Getting dashboard overview..." -ForegroundColor Yellow
try {
    $dashboard = Invoke-RestMethod -Uri "$baseUrl/admin/dashboard" `
        -Headers @{"X-API-Key"=$adminApiKey}
    
    Write-Host "✓ Dashboard data:" -ForegroundColor Green
    Write-Host "  Total users: $($dashboard.users.total)"
    Write-Host "  Total URLs: $($dashboard.urls.total)"
    Write-Host "  Total clicks: $($dashboard.urls.totalClicks)"
} catch {
    Write-Host "✗ Failed to get dashboard: $_" -ForegroundColor Red
}

# 2. List Users
Write-Host "`n2. Listing all users..." -ForegroundColor Yellow
try {
    $usersResponse = Invoke-RestMethod -Uri "$baseUrl/admin/users" `
        -Headers @{"X-API-Key"=$adminApiKey}
    
    Write-Host "✓ Found $($usersResponse.users.Count) users:" -ForegroundColor Green
    $usersResponse.users | ForEach-Object {
        Write-Host "  - ID: $($_.id), Email: $($_.email)"
    }
} catch {
    Write-Host "✗ Failed to list users: $_" -ForegroundColor Red
}

# 3. List URLs
Write-Host "`n3. Listing recent URLs..." -ForegroundColor Yellow
try {
    $urlsResponse = Invoke-RestMethod -Uri "$baseUrl/admin/urls" `
        -Headers @{"X-API-Key"=$adminApiKey}
    
    Write-Host "✓ Recent URLs:" -ForegroundColor Green
    $urlsResponse.urls | Select-Object -First 5 | ForEach-Object {
        Write-Host "  - $($_.slug) → $($_.longUrl) (Clicks: $($_.clicks))"
    }
} catch {
    Write-Host "✗ Failed to list URLs: $_" -ForegroundColor Red
}

# 4. Search URLs
Write-Host "`n4. Searching URLs..." -ForegroundColor Yellow
try {
    $searchResponse = Invoke-RestMethod -Uri "$baseUrl/admin/search/urls?q=test" `
        -Headers @{"X-API-Key"=$adminApiKey}
    
    Write-Host "✓ Search results for 'test':" -ForegroundColor Green
    if ($searchResponse.urls.Count -eq 0) {
        Write-Host "  No results found"
    } else {
        $searchResponse.urls | ForEach-Object {
            Write-Host "  - $($_.slug) → $($_.longUrl)"
        }
    }
} catch {
    Write-Host "✗ Search failed: $_" -ForegroundColor Red
}

# 5. Check Service Health
Write-Host "`n5. Checking service health..." -ForegroundColor Yellow
try {
    $healthResponse = Invoke-RestMethod -Uri "$baseUrl/admin/health/services" `
        -Headers @{"X-API-Key"=$adminApiKey}
    
    Write-Host "✓ Service status:" -ForegroundColor Green
    $healthResponse.services | ForEach-Object {
        $statusColor = if ($_.status -eq "healthy") { "Green" } else { "Red" }
        Write-Host "  - $($_.service): $($_.status)" -ForegroundColor $statusColor
    }
} catch {
    Write-Host "✗ Health check failed: $_" -ForegroundColor Red
}

# 6. Get Configuration
Write-Host "`n6. Getting configuration..." -ForegroundColor Yellow
try {
    $configResponse = Invoke-RestMethod -Uri "$baseUrl/admin/config" `
        -Headers @{"X-API-Key"=$adminApiKey}
    
    Write-Host "✓ Current domain: $($configResponse.domain)" -ForegroundColor Green
} catch {
    Write-Host "✗ Failed to get config: $_" -ForegroundColor Red
}

Write-Host "`n=== Complete! ===" -ForegroundColor Cyan
Write-Host "Remember: Admin access requires an API key from user ID 1" -ForegroundColor Yellow
