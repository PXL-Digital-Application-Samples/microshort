# Auth Service PowerShell Examples
$baseUrl = "http://localhost:3001"

Write-Host "=== Auth Service Examples ===" -ForegroundColor Cyan

# 1. Register a new user
Write-Host "`n1. Registering new user..." -ForegroundColor Yellow
$registerResponse = Invoke-RestMethod -Uri "$baseUrl/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body '{"email":"demo@example.com","password":"demo123"}'

Write-Host "User registered! Token:" -ForegroundColor Green
Write-Host $registerResponse.token

# 2. Login with existing user
Write-Host "`n2. Logging in..." -ForegroundColor Yellow
$loginResponse = Invoke-RestMethod -Uri "$baseUrl/auth/login" `
    -Method Post `
    -ContentType "application/json" `
    -Body '{"email":"demo@example.com","password":"demo123"}'

$token = $loginResponse.token
Write-Host "Login successful! Token saved." -ForegroundColor Green

# Test token with /auth/me endpoint
Write-Host "`n2a. Testing token with /auth/me..." -ForegroundColor Yellow
try {
    $meResponse = Invoke-RestMethod -Uri "$baseUrl/auth/me" `
        -Method Get `
        -Headers @{Authorization="Bearer $token"}
    Write-Host "Token valid! User: $($meResponse.email)" -ForegroundColor Green
} catch {
    Write-Host "Token validation failed: $_" -ForegroundColor Red
}

# 3. Generate API Key
Write-Host "`n3. Generating API key..." -ForegroundColor Yellow
$apiKeyResponse = Invoke-RestMethod -Uri "$baseUrl/auth/api-keys" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{Authorization="Bearer $token"} `
    -Body '{"name":"PowerShell Demo Key"}'

Write-Host "API Key generated!" -ForegroundColor Green
Write-Host "Key: $($apiKeyResponse.apiKey)"
Write-Host "Name: $($apiKeyResponse.name)"

# 4. Validate API Key
Write-Host "`n4. Validating API key..." -ForegroundColor Yellow
$validateResponse = Invoke-RestMethod -Uri "$baseUrl/auth/validate" `
    -Method Post `
    -ContentType "application/json" `
    -Body "{`"apiKey`":`"$($apiKeyResponse.apiKey)`"}"

Write-Host "Validation result:" -ForegroundColor Green
Write-Host "Valid: $($validateResponse.valid)"
Write-Host "User ID: $($validateResponse.userId)"

# 5. List API Keys
Write-Host "`n5. Listing API keys..." -ForegroundColor Yellow
try {
    $listResponse = Invoke-RestMethod -Uri "$baseUrl/auth/api-keys" `
        -Method Get `
        -Headers @{Authorization="Bearer $token"}
    
    Write-Host "Your API keys:" -ForegroundColor Green
    $listResponse.keys | ForEach-Object {
        Write-Host "- ID: $($_.id), Name: $($_.name), Created: $($_.createdAt)"
    }
} catch {
    Write-Host "Error listing keys: $_" -ForegroundColor Red
    Write-Host "Make sure you're using a valid JWT token" -ForegroundColor Yellow
}

# 6. Revoke API Key (optional - uncomment to test)
# Write-Host "`n6. Revoking API key..." -ForegroundColor Yellow
# $revokeResponse = Invoke-RestMethod -Uri "$baseUrl/auth/api-keys/$($apiKeyResponse.keyId)" `
#     -Method Delete `
#     -Headers @{Authorization="Bearer $token"}
# Write-Host "API key revoked!" -ForegroundColor Green

Write-Host "`n=== Complete! ===" -ForegroundColor Cyan
Write-Host "JWT Token (for reference):" -ForegroundColor Yellow
Write-Host $token
Write-Host "`nAPI Key (for reference):" -ForegroundColor Yellow
Write-Host $apiKeyResponse.apiKey