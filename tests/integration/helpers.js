import { execSync } from 'child_process';

// Base URLs are overridable via env vars so this suite doubles as a smoke
// test against a deployed stack, e.g.:
//   BASE_URL_REDIRECT=https://sho.rt BASE_URL_AUTH=https://api.sho.rt SKIP_DB_RESET=true npm test
export const BASE = {
  config:    process.env.BASE_URL_CONFIG    ?? 'http://localhost:3000',
  auth:      process.env.BASE_URL_AUTH      ?? 'http://localhost:3001',
  urls:      process.env.BASE_URL_URLS      ?? 'http://localhost:3002',
  redirect:  process.env.BASE_URL_REDIRECT  ?? 'http://localhost:8080',
  admin:     process.env.BASE_URL_ADMIN     ?? 'http://localhost:3003',
  adminUi:   process.env.BASE_URL_ADMIN_UI  ?? 'http://localhost:3004',
  analytics: process.env.BASE_URL_ANALYTICS ?? 'http://localhost:3005',
};

// Read a required variable from the environment (loaded from the root .env
// by env-setup.js). Failing loudly beats silently using a wrong dev default.
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Integration tests read it from the root .env — run: cp .env.example .env`
    );
  }
  return value;
}

// Wipes users, urls, and Redis (cache + rate-limit counters). Each step runs
// independently: a failure in one must not silently skip the others (the
// Redis flush in particular resets rate-limit counters the suite depends on).
export function resetDb() {
  if (process.env.SKIP_DB_RESET === 'true') return;

  const steps = [
    ['auth-db (postgres)', 'docker compose exec -T auth-db psql -U authuser -d auth -c "TRUNCATE users CASCADE"'],
    ['url-db (mysql)', `docker compose exec -T url-db mysql -u urluser -p${requireEnv('URL_DB_PASSWORD')} -D urlshort -e "TRUNCATE TABLE urls;"`],
    ['redis', 'docker compose exec -T redis redis-cli FLUSHALL'],
  ];

  const failures = [];
  for (const [name, cmd] of steps) {
    try {
      execSync(cmd, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      failures.push(`${name}: ${err.stderr?.toString().trim() || err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      'resetDb() failed — tests would run against dirty state and stale rate-limit counters.\n'
      + failures.map(f => `  - ${f}`).join('\n')
      + '\nIf you changed database passwords, recreate the volumes: docker compose down -v && docker compose up -d --build --wait'
    );
  }
}

export async function postEvents(events) {
  const res = await fetch(`${BASE.analytics}/events:batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': requireEnv('REDIRECT_SERVICE_TOKEN') },
    body: JSON.stringify(events),
  });
  return { status: res.status };
}

export async function getSlugCounts(slugs) {
  const res = await fetch(
    `${BASE.analytics}/stats/counts?slugs=${slugs.join(',')}`,
    { headers: { 'X-Service-Token': requireEnv('URL_SERVICE_TOKEN') } }
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
