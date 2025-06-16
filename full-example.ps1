# Full microshort example - register, get API key, create short URLs
Write-Host "=== Full Microshort Example ===" -ForegroundColor Cyan

# Step 1: Register a user
Write-Host "`n1. Registering user..." -ForegroundColor Yellow
$registerResponse = Invoke-RestMethod -Uri "http://localhost:3001/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body '{"email":"demo@microshort.com","password":"demo123"}'

$token = $registerResponse.token
Write-Host "✓ User registered!" -ForegroundColor Green

# Step 2: Generate API key
Write-Host "`n2. Generating API key..." -ForegroundColor Yellow
$apiKeyResponse = Invoke-RestMethod -Uri "http://localhost:3001/auth/api-keys" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{Authorization="Bearer $token"} `
    -Body '{"name":"Demo Key"}'

$apiKey = $apiKeyResponse.apiKey
Write-Host "✓ API key generated: $apiKey" -ForegroundColor Green

# Step 3: Create a short URL
Write-Host "`n3. Creating short URL..." -ForegroundColor Yellow
$urlResponse = Invoke-RestMethod -Uri "http://localhost:3002/urls" `
    -Method Post `
    -Headers @{"X-API-Key"=$apiKey} `
    -ContentType "application/json" `
    -Body '{"url":"https://github.com/microsoft/powershell/blob/master/docs/learning-powershell/create-powershell-scripts.md"}'

Write-Host "✓ Short URL created!" -ForegroundColor Green
Write-Host "   Long:  $($urlResponse.longUrl)" -ForegroundColor Gray
Write-Host "   Short: $($urlResponse.shortUrl)" -ForegroundColor Cyan

# Step 4: Test the redirect endpoint
Write-Host "`n4. Testing redirect lookup..." -ForegroundColor Yellow
$lookupResponse = Invoke-RestMethod -Uri "http://localhost:3002/urls/$($urlResponse.slug)"
Write-Host "✓ Redirect works! Points to: $($lookupResponse.longUrl)" -ForegroundColor Green

# Step 5: List all URLs
Write-Host "`n5. Listing all my URLs..." -ForegroundColor Yellow
$listResponse = Invoke-RestMethod -Uri "http://localhost:3002/urls" `
    -Headers @{"X-API-Key"=$apiKey}

Write-Host "✓ Found $($listResponse.urls.Count) URL(s):" -ForegroundColor Green
$listResponse.urls | ForEach-Object {
    Write-Host "   - $($_.shortUrl) (clicks: $($_.clicks))"
}

Write-Host "`n=== Complete! ===" -ForegroundColor Cyan
Write-Host "Your API key for future use: $apiKey" -ForegroundColor Yellow
Write-Host "Your short URL: $($urlResponse.shortUrl)" -ForegroundColor Yellow