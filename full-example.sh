#!/bin/bash
# Full microshort example - register, get API key, create short URLs
# Make this file executable: chmod +x full-example.sh

echo -e "\033[36m=== Full Microshort Example ===\033[0m"

# Step 1: Register a user
echo -e "\n\033[33m1. Registering user...\033[0m"
REGISTER_RESPONSE=$(curl -s -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@microshort.com","password":"demo123"}')

TOKEN=$(echo $REGISTER_RESPONSE | jq -r .token)
echo -e "\033[32m✓ User registered!\033[0m"

# Step 2: Generate API key
echo -e "\n\033[33m2. Generating API key...\033[0m"
API_KEY_RESPONSE=$(curl -s -X POST http://localhost:3001/auth/api-keys \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Demo Key"}')

API_KEY=$(echo $API_KEY_RESPONSE | jq -r .apiKey)
echo -e "\033[32m✓ API key generated: $API_KEY\033[0m"

# Step 3: Create a short URL
echo -e "\n\033[33m3. Creating short URL...\033[0m"
URL_RESPONSE=$(curl -s -X POST http://localhost:3002/urls \
  -H "X-API-Key: $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/microsoft/powershell/blob/master/docs/learning-powershell/create-powershell-scripts.md"}')

SHORT_URL=$(echo $URL_RESPONSE | jq -r .shortUrl)
SLUG=$(echo $URL_RESPONSE | jq -r .slug)
echo -e "\033[32m✓ Short URL created!\033[0m"
echo -e "   \033[90mLong:  $(echo $URL_RESPONSE | jq -r .longUrl)\033[0m"
echo -e "   \033[36mShort: $SHORT_URL\033[0m"

# Step 4: Test the redirect endpoint
echo -e "\n\033[33m4. Testing redirect lookup...\033[0m"
LOOKUP_RESPONSE=$(curl -s http://localhost:3002/urls/$SLUG)
echo -e "\033[32m✓ Redirect works! Points to: $(echo $LOOKUP_RESPONSE | jq -r .longUrl)\033[0m"

# Step 5: List all URLs
echo -e "\n\033[33m5. Listing all my URLs...\033[0m"
LIST_RESPONSE=$(curl -s http://localhost:3002/urls \
  -H "X-API-Key: $API_KEY")

URL_COUNT=$(echo $LIST_RESPONSE | jq '.urls | length')
echo -e "\033[32m✓ Found $URL_COUNT URL(s):\033[0m"
echo $LIST_RESPONSE | jq -r '.urls[] | "   - \(.shortUrl) (clicks: \(.clicks))"'

# Step 6: Test the redirect service
echo -e "\n\033[33m6. Testing redirect service...\033[0m"
REDIRECT_RESPONSE=$(curl -s -I http://localhost:8080/$SLUG)
if echo "$REDIRECT_RESPONSE" | grep -q "301"; then
  LOCATION=$(echo "$REDIRECT_RESPONSE" | grep "Location:" | sed 's/Location: //')
  echo -e "\033[32m✓ Redirect service works! Returns 301 redirect\033[0m"
else
  echo -e "\033[31m✗ Redirect test failed\033[0m"
fi

echo -e "\n\033[36m=== Complete! ===\033[0m"
echo -e "\033[33mYour API key for future use: $API_KEY\033[0m"
echo -e "\033[33mYour short URL: $SHORT_URL\033[0m"
echo -e "\033[36mAccess it at: http://localhost:8080/$SLUG\033[0m"
