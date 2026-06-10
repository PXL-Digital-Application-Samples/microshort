import mysql from 'mysql2/promise';
import { env } from './env.js';
import logger from './logger.js';

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: parseInt(env.DB_PORT),
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Create a new URL
export async function createUrl(userId, longUrl, slug) {
  const [result] = await pool.execute(
    'INSERT INTO urls (user_id, long_url, slug) VALUES (?, ?, ?)',
    [userId, longUrl, slug]
  );
  
  return {
    id: result.insertId,
    user_id: userId,
    long_url: longUrl,
    slug: slug,
    clicks: 0,
    created_at: new Date()
  };
}

// Get URL by slug
export async function getUrlBySlug(slug) {
  const [rows] = await pool.execute(
    'SELECT * FROM urls WHERE slug = ?',
    [slug]
  );
  
  return rows[0];
}

// Get all URLs for a user
export async function getUserUrls(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM urls WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  
  return rows;
}

// Delete a URL
export async function deleteUrl(urlId) {
  await pool.execute(
    'DELETE FROM urls WHERE id = ?',
    [urlId]
  );
}

// Update a URL
export async function updateUrl(urlId, newLongUrl) {
  await pool.execute(
    'UPDATE urls SET long_url = ? WHERE id = ?',
    [newLongUrl, urlId]
  );
  return {
    id: urlId,
    long_url: newLongUrl
  };
}

// Updates the eventually-consistent click count cache. Called by the
// scheduled analytics sync job, not on the request hot path.
export async function updateClickCount(slug, count) {
  await pool.execute(
    'UPDATE urls SET clicks = ? WHERE slug = ?',
    [count, slug]
  );
}

// Health check
export async function checkHealth() {
  try {
    await pool.execute('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ err }, 'Database health check failed');
    return false;
  }
}

// Admin: Get all URLs
export async function getAllUrls({ cursor, limit = 50 } = {}) {
  const [rows] = cursor
    ? await pool.query(
        'SELECT * FROM urls WHERE id < ? ORDER BY id DESC LIMIT ?',
        [cursor, limit + 1]
      )
    : await pool.query(
        'SELECT * FROM urls ORDER BY id DESC LIMIT ?',
        [limit + 1]
      );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    urls: page,
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
}

export async function searchUrls(q) {
  const escapedQ = q.replace(/[\\%_]/g, '\\$&');
  const prefix = `${escapedQ}%`;
  
  const cleanPhrase = q.replace(/[+\><~*"()]/g, '');
  const phrase = `"${cleanPhrase}"`;
  
  const [rows] = await pool.execute(
    `SELECT * FROM urls
     WHERE slug LIKE ?
        OR MATCH(long_url) AGAINST(? IN BOOLEAN MODE)
     ORDER BY created_at DESC LIMIT 100`,
    [prefix, phrase]
  );
  return rows;
}

// Admin: Get URL statistics
export async function getUrlStats() {
  const [[totalStats]] = await pool.execute(
    'SELECT COUNT(*) as total_urls, SUM(clicks) as total_clicks FROM urls'
  );
  
  const [[recentStats]] = await pool.execute(
    'SELECT COUNT(*) as recent_urls FROM urls WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
  );
  
  const [topUrls] = await pool.execute(
    'SELECT slug, long_url, clicks FROM urls ORDER BY clicks DESC LIMIT 10'
  );
  
  return {
    totalUrls: parseInt(totalStats.total_urls),
    totalClicks: parseInt(totalStats.total_clicks || 0),
    recentUrls: parseInt(recentStats.recent_urls),
    topUrls: topUrls.map(u => ({
      slug: u.slug,
      longUrl: u.long_url,
      clicks: u.clicks
    }))
  };
}