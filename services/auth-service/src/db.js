import postgres from 'postgres';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';

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

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

// Create a new user
export async function createUser(email, passwordHash) {
  const [{ count }] = await sql`SELECT COUNT(*) as count FROM users`;
  const role = parseInt(count) === 0 ? 'admin' : 'user';
  const [user] = await sql`
    INSERT INTO users (email, password_hash, role)
    VALUES (${email}, ${passwordHash}, ${role})
    RETURNING id, email, role, created_at
  `;
  return user;
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
      .catch(err => console.error('last_used_at update failed:', err));
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
    console.error('Database health check failed:', err);
    return false;
  }
}

// Admin: Get all users
export async function getAllUsers() {
  const users = await sql`
    SELECT id, email, created_at
    FROM users
    ORDER BY created_at DESC
  `;
  return users;
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