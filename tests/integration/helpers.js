import { execSync } from 'child_process';

export const BASE = {
  config:    'http://localhost:3000',
  auth:      'http://localhost:3001',
  urls:      'http://localhost:3002',
  redirect:  'http://localhost:8080',
  admin:     'http://localhost:3003',
  adminUi:   'http://localhost:3004',
  analytics: 'http://localhost:3005',
};

export function resetDb() {
  try {
    const URL_DB_PASS = process.env.URL_DB_PASSWORD ?? 'urlpass';
    execSync('docker compose exec -T auth-db psql -U authuser -d auth -c "TRUNCATE users CASCADE"');
    execSync(`docker compose exec -T url-db mysql -u urluser -p${URL_DB_PASS} -D urlshort -e "TRUNCATE TABLE urls;"`);
    execSync('docker compose exec -T redis redis-cli FLUSHALL');
  } catch (err) {
    console.error('Failed to reset databases:', err.message);
  }
}

const SERVICE_TOKEN = process.env.SERVICE_TOKEN || 'dev-service-token-change-in-production';

export async function postEvents(events) {
  const res = await fetch(`${BASE.analytics}/events:batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': SERVICE_TOKEN },
    body: JSON.stringify(events),
  });
  return { status: res.status };
}

export async function getSlugCounts(slugs) {
  const res = await fetch(
    `${BASE.analytics}/stats/counts?slugs=${slugs.join(',')}`,
    { headers: { 'X-Service-Token': SERVICE_TOKEN } }
  );
  return { status: res.status, ...(res.ok ? await res.json() : {}) };
}

// Unique email prevents cross-test state collisions on a warm stack
export const uniqueEmail = (label = 'user') =>
  `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

export async function register(email, password = 'Test-pass-123!') {
  const res = await fetch(`${BASE.auth}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, ...(await res.json()) };
}

export async function createApiKey(token, name = 'test-key') {
  const res = await fetch(`${BASE.auth}/auth/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  return { status: res.status, ...(await res.json()) };
}

export async function createShortUrl(apiKey, url) {
  const res = await fetch(`${BASE.urls}/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ url }),
  });
  return { status: res.status, ...(await res.json()) };
}