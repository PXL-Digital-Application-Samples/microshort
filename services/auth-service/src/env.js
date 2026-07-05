import { cleanEnv, str, port, num } from 'envalid';

export const env = cleanEnv(process.env, {
  JWT_SECRET:                 str({ desc: 'JWT signing secret — never use the default in production' }),
  DB_PASSWORD:                str({ desc: 'PostgreSQL password for auth_db' }),
  SERVICE_TOKEN:              str({ default: '', desc: 'Legacy shared service-to-service token (deprecated, optional)' }),
  ADMIN_SERVICE_TOKEN:        str({ desc: 'Token required for admin calls to auth-service' }),
  DB_HOST:                    str({ default: 'auth-db' }),
  DB_PORT:                    port({ default: 5432 }),
  DB_NAME:                    str({ default: 'auth' }),
  DB_USER:                    str({ default: 'authuser' }),
  REDIS_URL:                  str({ default: 'redis://redis:6379', desc: 'Redis connection string for rate limiting' }),
  PORT:                       port({ default: 3001 }),
  LOG_LEVEL:                  str({ default: 'info' }),
  CONFIG_SERVICE_URL:         str({ default: 'http://config-service:3000' }),
  LOGIN_RATE_LIMIT_WINDOW_MS: num({ default: 15 * 60 * 1000 }),
  LOGIN_RATE_LIMIT_MAX:       num({ default: 10 }),
  ALLOWED_ORIGINS:            str({ default: '*' }),
  JWT_EXPIRES_IN:             str({ default: '1h' }),
  REFRESH_TOKEN_EXPIRES_IN:   str({ default: '7d' }),
  TRUST_PROXY:                str({ default: '1', desc: 'Express trust proxy setting: hop count, true/false, or subnet' }),
});

// Refuse to boot with placeholder secrets outside local development.
if (process.env.NODE_ENV === 'production') {
  const placeholders = ['JWT_SECRET', 'DB_PASSWORD', 'ADMIN_SERVICE_TOKEN']
    .filter(name => env[name].includes('change-me'));
  if (placeholders.length > 0) {
    throw new Error(
      `Refusing to start in production with placeholder secrets: ${placeholders.join(', ')}`
    );
  }
}
