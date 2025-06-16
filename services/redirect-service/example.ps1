# Redirect Service PowerShell Examples
$baseUrl = "http://localhost:8080"

Write-Host "=== Redirect Service Examples ===" -ForegroundColor Cyan

# 1. Check home page
Write-Host "`n1. Checking home page..." -ForegroundColor Yellow
$homeResponse = Invoke-WebRequest -Uri $baseUrl -UseBasicParsing
Write-Host "✓ Home page returned: $($homeResponse.StatusCode)" -ForegroundColor Green

# 2. Test a redirect (you'll need a valid slug)
Write-Host "`n2. Testing redirect..." -ForegroundColor Yellow
Write-Host "First, let's create a test URL via url-service" -ForegroundColor Gray

# You would need an API key for this part
$apiKey = "YOUR_API_KEY_HERE"  # Replace with actual API key

try {
    # Create a test URL
    $createResponse = Invoke-RestMethod -Uri "http://localhost:3002/urls" `
        -Method Post `
        -Headers @{"X-API-Key"=$apiKey} `
        -ContentType "application/json" `
        -Body '{"url":"https://example.com","customSlug":"testredirect"}'
    
    Write-Host "Created test URL with slug: $($createResponse.slug)" -ForegroundColor Green
    
    # Test the redirect
    Write-Host "`n3. Testing the redirect..." -ForegroundColor Yellow
    $redirectResponse = Invoke-WebRequest -Uri "$baseUrl/$($createResponse.slug)" `
        -MaximumRedirection 0 -ErrorAction SilentlyContinue
    
    if ($redirectResponse.StatusCode -eq 301) {
        Write-Host "✓ Redirect works! Location: $($redirectResponse.Headers.Location)" -ForegroundColor Green
    }
} catch {
    if ($_.Exception.Response.StatusCode -eq 301) {
        Write-Host "✓ Redirect works! (301 redirect detected)" -ForegroundColor Green
    } else {
        Write-Host "Note: You need a valid API key to create test URLs" -ForegroundColor Yellow
        Write-Host "Error: $_" -ForegroundColor Red
    }
}

# 4. Test 404
Write-Host "`n4. Testing 404 page..." -ForegroundColor Yellow
try {
    $notFoundResponse = Invoke-WebRequest -Uri "$baseUrl/doesnotexist123" -UseBasicParsing
} catch {
    if ($_.Exception.Response.StatusCode -eq 404) {
        Write-Host "✓ 404 page works correctly" -ForegroundColor Green
    } else {
        Write-Host "✗ Unexpected error: $_" -ForegroundColor Red
    }
}

# 5. Health check
Write-Host "`n5. Health check..." -ForegroundColor Yellow
$healthResponse = Invoke-RestMethod -Uri "$baseUrl/health"
Write-Host "✓ Service is healthy" -ForegroundColor Green

Write-Host "`n=== Complete! ===" -ForegroundColor Cyan
Write-Host "Visit $baseUrl to see the home page" -ForegroundColor Yellow