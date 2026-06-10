import fs from 'fs';
import path from 'path';

// Try using Node's native process.loadEnvFile first (available in Node 20.6.0+)
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  } else {
    loadEnvFallback();
  }
} catch (e) {
  // If .env doesn't exist or loadEnvFile fails (e.g., file not found), fall back
  loadEnvFallback();
}

function loadEnvFallback() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return;
    }
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.substring(0, idx).trim();
        let val = trimmed.substring(idx + 1).trim();
        // Strip quotes if the value is wrapped in single or double quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    // Ignore fallback errors
  }
}
