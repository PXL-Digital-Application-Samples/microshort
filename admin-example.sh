#!/bin/bash
# Admin Example - Shows how to use admin service
# Make this file executable: chmod +x admin-example.sh

echo -e "\033[36m=== Admin Service Demo ===\033[0m"

# First, we need to get an admin API key (user ID 1)
echo -e "\n\033[33m1. Creating admin user (first user is admin)...\033[0m"

# Register admin if not exists
ADMIN_REG=$(curl -s -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@microshort.com","password":"admin123"}' 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$ADMIN_REG" ]; then
  ADMIN_TOKEN=$(echo $ADMIN_REG | jq -r .token 2>/dev/null)
  if [ -n "$ADMIN_TOKEN" ] && [ "$ADMIN_TOKEN" != "null" ]; then
    echo -e "\033[32m✓ Admin user created\033[0m"
  else
    # If user exists, login instead
    echo -e "\033[90mAdmin exists, logging in...\033[0m"
    ADMIN_LOGIN=$(curl -s -X POST http://localhost:3001/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"email":"admin@microshort.com","password":"admin123"}')
    ADMIN_TOKEN=$(echo $ADMIN_LOGIN | jq -r .token)
  fi
fi

# Generate admin API key
echo -e "\n\033[33m2. Generating admin API key...\033[0m"
ADMIN_KEY_RESPONSE=$(curl -s -X POST http://localhost:3001/auth/api-keys \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"Admin Key"}')

ADMIN_API_KEY=$(echo $ADMIN_KEY_RESPONSE | jq -r .apiKey)
echo -e "\033[32m✓ Admin API key: $ADMIN_API_KEY\033[0m"

# Create some test data
echo -e "\n\033[33m3. Creating test data...\033[0m"

# Create a regular user
USER_REG=$(curl -s -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"user123"}' 2>/dev/null)

if [ $? -eq 0 ]; then
  USER_TOKEN=$(echo $USER_REG | jq -r .token 2>/dev/null)
  if [ -n "$USER_TOKEN" ] && [ "$USER_TOKEN" != "null" ]; then
    # Get API key for regular user
    USER_KEY_RESPONSE=$(curl -s -X POST http://localhost:3001/auth/api-keys \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $USER_TOKEN" \
      -d '{"name":"User Key"}')
    
    USER_API_KEY=$(echo $USER_KEY_RESPONSE | jq -r .apiKey)
    
    # Create some URLs
    for i in 1 2 3; do
      curl -s -X POST http://localhost:3002/urls \
        -H "X-API-Key: $USER_API_KEY" \
        -H 'Content-Type: application/json' \
        -d "{\"url\":\"https://example.com/page$i\"}" > /dev/null
    done
    
    echo -e "\033[32m✓ Created test user and URLs\033[0m"
  else
    echo -e "\033[90mTest data already exists\033[0m"
  fi
fi

# Now use admin service
echo -e "\n\033[33m4. Testing admin endpoints...\033[0m"

# Dashboard
echo -e "\n  \033[36ma) Dashboard:\033[0m"
DASHBOARD=$(curl -s http://localhost:3003/admin/dashboard \
  -H "X-API-Key: $ADMIN_API_KEY")

echo "     Total users: $(echo $DASHBOARD | jq -r .users.total)"
echo "     Total URLs: $(echo $DASHBOARD | jq -r .urls.total)"
echo "     Total clicks: $(echo $DASHBOARD | jq -r .urls.totalClicks)"

# List users
echo -e "\n  \033[36mb) All users:\033[0m"
USERS=$(curl -s http://localhost:3003/admin/users \
  -H "X-API-Key: $ADMIN_API_KEY")

echo $USERS | jq -r '.users[] | "     - \(.email) (ID: \(.id))"'

# List URLs
echo -e "\n  \033[36mc) Recent URLs:\033[0m"
URLS=$(curl -s http://localhost:3003/admin/urls \
  -H "X-API-Key: $ADMIN_API_KEY")

echo $URLS | jq -r '.urls[:5][] | "     - \(.slug) → \(.longUrl[:40])..."'

# Service health
echo -e "\n  \033[36md) Service health:\033[0m"
HEALTH=$(curl -s http://localhost:3003/admin/health/services \
  -H "X-API-Key: $ADMIN_API_KEY")

echo $HEALTH | jq -r '.services[] | "     - \(.service): \(.status)"'

echo -e "\n\033[36m=== Admin Demo Complete! ===\033[0m"
echo -e "\033[33mAdmin API key saved for future use: $ADMIN_API_KEY\033[0m"
echo -e "\033[33mAdmin service URL: http://localhost:3003\033[0m"
