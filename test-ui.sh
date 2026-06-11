#!/bin/bash
# Smoke test: checks for known VanJS rendering bugs in source + validates API

PASS=0
FAIL=0

check() {
    local desc="$1"
    local result="$2"
    if [ "$result" = "0" ]; then
        echo "  PASS: $desc"
        ((PASS++))
    else
        echo "  FAIL: $desc"
        ((FAIL++))
    fi
}

echo "=== Source pattern checks ==="

# 1. && html` patterns — return false when left side is falsy boolean
COUNT=$(grep -rn '&& html`' services/admin-ui/public/components/ services/admin-ui/public/app.js | wc -l)
check "No '&& html\`' patterns (renders 'false' when falsy)" "$([ $COUNT -eq 0 ] && echo 0 || echo 1)"
[ $COUNT -gt 0 ] && grep -rn '&& html`' services/admin-ui/public/components/ services/admin-ui/public/app.js

# 2. Boolean state used as template child without ternary guard
#    e.g. ${loading.val} renders "false" if loading is boolean false
BOOL_STATES="loading\.val\|saving\.val"
COUNT=$(grep -rn "\${.*\($BOOL_STATES\).*}" services/admin-ui/public/components/ services/admin-ui/public/app.js \
  | grep -v '[=?]' | grep -v '=>' | wc -l)
check "No raw boolean state used as template child" "$([ $COUNT -eq 0 ] && echo 0 || echo 1)"
[ $COUNT -gt 0 ] && grep -rn "\${.*\($BOOL_STATES\).*}" services/admin-ui/public/components/ services/admin-ui/public/app.js | grep -v '[=?]' | grep -v '=>'
echo ""
echo "=== API smoke tests ==="

BASE_AUTH="http://localhost:3001"
BASE_ADMIN="http://localhost:3003"

# Login as the admin user (first registered user gets admin role)
RESP=$(curl -sf -X POST $BASE_AUTH/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"test123"}' 2>/dev/null)
TOKEN=$(echo $RESP | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
check "Admin login" "$([ -n \"$TOKEN\" ] && echo 0 || echo 1)"

APIKEY_RESP=$(curl -sf -X POST $BASE_AUTH/auth/api-keys \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null)
APIKEY=$(echo $APIKEY_RESP | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
check "Create API key" "$([ -n \"$APIKEY\" ] && echo 0 || echo 1)"

# Dashboard
DASH=$(curl -sf $BASE_ADMIN/admin/dashboard -H "X-API-Key: $APIKEY" 2>/dev/null)
check "GET /admin/dashboard returns data" "$(echo $DASH | grep -q '"users"' && echo 0 || echo 1)"

# Users
USERS=$(curl -sf $BASE_ADMIN/admin/users -H "X-API-Key: $APIKEY" 2>/dev/null)
check "GET /admin/users returns array" "$(echo $USERS | grep -q '"users"' && echo 0 || echo 1)"

# URLs
URLS=$(curl -sf $BASE_ADMIN/admin/urls -H "X-API-Key: $APIKEY" 2>/dev/null)
check "GET /admin/urls returns array" "$(echo $URLS | grep -q '"urls"' && echo 0 || echo 1)"

# Health
HEALTH=$(curl -sf $BASE_ADMIN/admin/health/services -H "X-API-Key: $APIKEY" 2>/dev/null)
check "GET /admin/health/services returns services" "$(echo $HEALTH | grep -q '"services"' && echo 0 || echo 1)"

echo ""
echo "=== Seed test URLs ==="

BASE_URL="http://localhost:3002"

URLS=(
    "https://www.google.com|google"
    "https://www.github.com|github"
    "https://www.wikipedia.org|wiki"
    "https://www.youtube.com|yt"
    "https://www.stackoverflow.com|so"
)

for entry in "${URLS[@]}"; do
    URL=$(echo $entry | cut -d'|' -f1)
    SLUG=$(echo $entry | cut -d'|' -f2)
    HTTP_CODE=$(curl -s -o /tmp/url_resp.txt -w "%{http_code}" -X POST $BASE_URL/urls \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $APIKEY" \
        -d "{\"url\":\"$URL\",\"customSlug\":\"$SLUG\"}")
    RESP=$(cat /tmp/url_resp.txt)
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        echo "  PASS: Created slug /$SLUG → $URL"
        ((PASS++))
    elif [ "$HTTP_CODE" = "409" ]; then
        echo "  SKIP: /$SLUG already exists"
    else
        echo "  FAIL: Could not create /$SLUG (HTTP $HTTP_CODE: $RESP)"
        ((FAIL++))
    fi
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
