import postgres from 'postgres';
import { nanoid } from 'nanoid';
import { env } from './env.js';
import { hashKey, isValidApiKeyFormat } from './utils.js';
import logger from './logger.js';

export const sql = postgres({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  max: 10, // connection pool size
  idle_timeout: 20,
  connect_timeout: 10,
});

// Create a new user
export async function createUser(email, passwordHash) {
  return sql.begin(async sql => {
    await sql`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`;
    const [{ count }] = await sql`SELECT COUNT(*) as count FROM users`;
    const role = parseInt(count) === 0 ? 'admin' : 'user';
    const [user] = await sql`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${passwordHash}, ${role})
      RETURNING id, email, role, created_at
    `;
    return user;
  });
}

// Find user by email
export async function findUserByEmail(email) {
  const [user] = await sql`
    SELECT id, email, password_hash, role, created_at
    FROM users
    WHERE email = ${email}
  `;
  return user;
}

// Find user by ID
export async function getUserById(id) {
  const [user] = await sql`
    SELECT id, email, password_hash, role, created_at
    FROM users
    WHERE id = ${id}
  `;
  return user;
}

// Create an API key
export async function createApiKey(userId, name) {
  const key = `msh_${nanoid(32)}`;
  const keyHash = hashKey(key);
  const [apiKey] = await sql`
    INSERT INTO api_keys (user_id, key_hash, name)
    VALUES (${userId}, ${keyHash}, ${name})
    RETURNING id, name, created_at
  `;
  // Return the plaintext key exactly once — it is never stored.
  return { ...apiKey, key };
}

// Validate an API key
export async function validateApiKey(key) {
  if (!isValidApiKeyFormat(key)) return undefined;
  const keyHash = hashKey(key);
  const [keyData] = await sql`
    SELECT k.id, k.user_id, u.role
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ${keyHash}
      AND k.revoked_at IS NULL
  `;
  if (keyData) {
    // Fire-and-forget: decouple last_used_at from the hot path (CR 2.3).
    // Validation is now a pure read; the UPDATE happens asynchronously.
    sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${keyData.id}`
      .catch(err => logger.error({ err }, 'last_used_at update failed'));
  }
  return keyData; // { id, user_id, role } or undefined
}

// Get user's API keys
export async function getUserApiKeys(userId) {
  const keys = await sql`
    SELECT id, name, created_at, last_used_at
    FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  return keys;
}

// Revoke an API key
export async function revokeApiKey(userId, keyId) {
  const [result] = await sql`
    UPDATE api_keys
    SET revoked_at = NOW()
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `;
  return result; // undefined if key not found or already revoked
}

// Health check for database
export async function checkHealth() {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, 'Database health check failed');
    return false;
  }
}

export async function getAllUsers({ cursor, limit = 50 } = {}) {
  const users = cursor
    ? await sql`
        SELECT id, email, role, created_at FROM users
        WHERE id < ${cursor}
        ORDER BY id DESC LIMIT ${limit + 1}`
    : await sql`
        SELECT id, email, role, created_at FROM users
        ORDER BY id DESC LIMIT ${limit + 1}`;

  const hasMore = users.length > limit;
  const page = hasMore ? users.slice(0, limit) : users;
  return {
    users: page.map(u => ({ id: u.id, email: u.email, role: u.role, createdAt: u.created_at })),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
}

// Admin: Get auth statistics
export async function getAuthStats() {
  const [userStats] = await sql`
    SELECT COUNT(*) as total_users
    FROM users
  `;
  
  const [keyStats] = await sql`
    SELECT COUNT(*) as total_keys
    FROM api_keys
    WHERE revoked_at IS NULL
  `;
  
  const recentUsers = await sql`
    SELECT COUNT(*) as count
    FROM users
    WHERE created_at >= NOW() - INTERVAL '7 days'
  `;
  
  return {
    totalUsers: parseInt(userStats.total_users),
    totalApiKeys: parseInt(keyStats.total_keys),
    recentUsers: parseInt(recentUsers[0].count)
  };
}