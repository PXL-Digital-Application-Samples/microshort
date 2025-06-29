import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'url-db',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'urlshort',
  user: process.env.DB_USER || 'urluser',
  password: process.env.DB_PASSWORD || 'urlpass',
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
  
  const [rows] = await pool.execute(
    'SELECT * FROM urls WHERE id = ?',
    [result.insertId]
  );
  
  return rows[0];
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

// Increment click count
export async function incrementClicks(urlId) {
  await pool.execute(
    'UPDATE urls SET clicks = clicks + 1 WHERE id = ?',
    [urlId]
  );
}

// Health check
export async function checkHealth() {
  try {
    await pool.execute('SELECT 1');
    return true;
  } catch (err) {
    console.error('Database health check failed:', err);
    return false;
  }
}

// Admin: Get all URLs
export async function getAllUrls() {
  const [rows] = await pool.execute(
    'SELECT * FROM urls ORDER BY created_at DESC LIMIT 1000'
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
    topUrls: topUrls
  };
}