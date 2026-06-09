const HEALTH_URLS = [
  'http://localhost:3000/health',  // config-service
  'http://localhost:3001/health',  // auth-service
  'http://localhost:3002/health',  // url-service
  'http://localhost:8080/health',  // redirect-service
  'http://localhost:3003/health',  // admin-service
];

export async function setup() {
  const deadline = Date.now() + 60_000;
  for (const url of HEALTH_URLS) {
    while (Date.now() < deadline) {
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (Date.now() >= deadline) {
      throw new Error(`Stack not healthy after 60 s — is compose running? (${url})`);
    }
  }
}