# URL Service PowerShell Examples
$baseUrl = "http://localhost:3002"
$apiKey = "YOUR_API_KEY_HERE"  # Replace with actual API key

Write-Host "=== URL Service Examples ===" -ForegroundColor Cyan

# 1. Create short URL with random slug
Write-Host "`n1. Creating short URL with random slug..." -ForegroundColor Yellow
$createResponse = Invoke-RestMethod -Uri "$baseUrl/urls" `
    -Method Post `
    -Headers @{"X-API-Key"=$apiKey} `
    -ContentType "application/json" `
    -Body '{"url":"https://github.com/example/really-long-repository-name/blob/main/docs/getting-started.md"}'

Write-Host "Short URL created!" -ForegroundColor Green
Write-Host "Short: $($createResponse.shortUrl)"
Write-Host "Slug: $($createResponse.slug)"

$randomSlug = $createResponse.slug

# 2. Create short URL with custom slug
Write-Host "`n2. Creating short URL with custom slug..." -ForegroundColor Yellow
try {
    $customResponse = Invoke-RestMethod -Uri "$baseUrl/urls" `
        -Method Post `
        -Headers @{"X-API-Key"=$apiKey} `
        -ContentType "application/json" `
        -Body '{"url":"https://example.com/products","customSlug":"myproduct"}'
    
    Write-Host "Custom URL created!" -ForegroundColor Green
    Write-Host "Short: $($customResponse.shortUrl)"
} catch {
    Write-Host "Custom slug might already exist: $_" -ForegroundColor Yellow
}

# 3. Get URL by slug (public endpoint)
Write-Host "`n3. Getting URL details..." -ForegroundColor Yellow
$getResponse = Invoke-RestMethod -Uri "$baseUrl/urls/$randomSlug" `
    -Method Get

Write-Host "URL found!" -ForegroundColor Green
Write-Host "Long URL: $($getResponse.longUrl)"

# 4. List my URLs
Write-Host "`n4. Listing my URLs..." -ForegroundColor Yellow
$listResponse = Invoke-RestMethod -Uri "$baseUrl/urls" `
    -Method Get `
    -Headers @{"X-API-Key"=$apiKey}

Write-Host "Your URLs:" -ForegroundColor Green
$listResponse.urls | ForEach-Object {
    Write-Host "- $($_.shortUrl) → $($_.longUrl) (Clicks: $($_.clicks))"
}

# 5. Delete a URL (optional - uncomment to test)
# Write-Host "`n5. Deleting URL..." -ForegroundColor Yellow
# $deleteResponse = Invoke-RestMethod -Uri "$baseUrl/urls/$randomSlug" `
#     -Method Delete `
#     -Headers @{"X-API-Key"=$apiKey}
# Write-Host "URL deleted!" -ForegroundColor Green

Write-Host "`n=== Complete! ===" -ForegroundColor Cyan
Write-Host "Remember to replace YOUR_API_KEY_HERE with an actual API key from auth-service" -ForegroundColor Yellow
