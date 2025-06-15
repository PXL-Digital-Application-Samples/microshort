#!/bin/bash
# Make this file executable: chmod +x quickstart.sh

echo "Starting microshort services..."

# Start services
docker compose up -d

# Wait for services to be ready
echo "Waiting for services to start..."
sleep 10

# Check health
echo -e "\nChecking service health:"
curl -s http://localhost:3000/health && echo " ✓ Config service is healthy"
curl -s http://localhost:3001/health && echo " ✓ Auth service is healthy"

echo -e "\nServices are running!"
echo "Config service: http://localhost:3000/docs"
echo "Auth service: http://localhost:3001"

echo -e "\nTo test auth service:"
echo "1. Register a user:"
echo "   TOKEN=\$(curl -s -X POST http://localhost:3001/auth/register \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"email\":\"test@example.com\",\"password\":\"test123\"}' | jq -r .token)"
echo "   echo \$TOKEN"

echo -e "\n2. Login:"
echo "   TOKEN=\$(curl -s -X POST http://localhost:3001/auth/login \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"email\":\"test@example.com\",\"password\":\"test123\"}' | jq -r .token)"

echo -e "\n3. Generate API key:"
echo "   curl -X POST http://localhost:3001/auth/api-keys \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -H \"Authorization: Bearer \$TOKEN\" \\"
echo "     -d '{\"name\":\"Development Key\"}'"

echo -e "\nTo stop services: docker compose down"
echo "To view logs: docker compose logs -f"