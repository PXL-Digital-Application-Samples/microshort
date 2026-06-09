import { cleanEnv, str } from 'envalid';

export const env = cleanEnv(process.env, {
  JWT_SECRET:                 str({ desc: 'JWT signing secret — never use the default in production' }),
  DB_PASSWORD:                str({ desc: 'PostgreSQL password for auth_db' }),
  DB_HOST:                    str({ default: 'auth-db' }),
  DB_PORT:                    str({ default: '5432' }),
  DB_NAME:                    str({ default: 'auth' }),
  DB_USER:                    str({ default: 'authuser' }),
  REDIS_URL:                  str({ default: 'redis://redis:6379', desc: 'Redis connection string for rate limiting' }),
  PORT:                       str({ default: '3001' }),
  LOG_LEVEL:                  str({ default: 'info' }),
  CONFIG_SERVICE_URL:         str({ default: 'http://config-service:3000' }),
  LOGIN_RATE_LIMIT_WINDOW_MS: str({ default: String(15 * 60 * 1000) }),
  LOGIN_RATE_LIMIT_MAX:       str({ default: '10' }),
});
