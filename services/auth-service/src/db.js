import postgres from 'postgres';
import { nanoid } from 'nanoid';

const sql = postgres({
  host: process.env.DB_HOST || 'auth-db',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'auth',
  username: process.env.DB_USER || 'authuser',
  password: process.env.DB_PASSWORD || 'authpass',
  max: 10, // connection pool size
  idle_timeout: 20,
  connect_timeout: 10,
});

// Create a new user
export async function createUser(email, passwordHash) {
  const [user] = await sql`
    INSERT INTO users (email, password_hash)
    VALUES (${email}, ${passwordHash})
    RETURNING id, email, created_at
  `;
  return user;
}

// Find user by email
export async function findUserByEmail(email) {
  const [user] = await sql`
    SELECT id, email, password_hash, created_at
    FROM users
    WHERE email = ${email}
  `;
  return user;
}

// Create an API key
export async function createApiKey(userId, name) {
  const key = `msh_${nanoid(32)}`;
  const [apiKey] = await sql`
    INSERT INTO api_keys (user_id, key, name)
    VALUES (${userId}, ${key}, ${name})
    RETURNING id, key, name, created_at
  `;
  return apiKey;
}

// Validate an API key
export async function validateApiKey(key) {
  const [keyData] = await sql`
    UPDATE api_keys
    SET last_used_at = NOW()
    WHERE key = ${key}
    RETURNING id, user_id, name
  `;
  return keyData;
}

// Get user's API keys
export async function getUserApiKeys(userId) {
  const keys = await sql`
    SELECT id, name, created_at, last_used_at
    FROM api_keys
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return keys;
}

// Revoke an API key
export async function revokeApiKey(userId, keyId) {
  const [result] = await sql`
    DELETE FROM api_keys
    WHERE id = ${keyId} AND user_id = ${userId}
    RETURNING id
  `;
  return result;
}

// Health check for database
export async function checkHealth() {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    console.error('Database health check failed:', err);
    return false;
  }
}