import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createUrl, getUrlBySlug, getUserUrls, deleteUrl, incrementClicks, getAllUrls, getUrlStats } from './db.js';
import { nanoid } from 'nanoid';

const app = express();
const PORT = process.env.PORT || 3002;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';

app.use(cors());
app.use(express.json());

// Cache for domain config
let cachedDomain = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

// Get domain from config service
async function getDomain() {
  if (cachedDomain && Date.now() - cacheTime < CACHE_TTL) {
    return cachedDomain;
  }
  
  try {
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`);
    const data = await response.json();
    cachedDomain = data.domain;
    cacheTime = Date.now();
    return cachedDomain;
  } catch (err) {
    console.error('Failed to get domain:', err);
    throw new Error('Configuration service unavailable');
  }
}

// Validate API key middleware
async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    
    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const data = await response.json();
    req.user = { id: data.userId };
    next();
  } catch (err) {
    console.error('Auth validation error:', err);
    res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Create short URL
app.post('/urls', validateApiKey, async (req, res) => {
  try {
    const { url, customSlug } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }
    
    // Basic URL validation
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    // Generate or validate slug
    let slug = customSlug;
    if (!slug) {
      slug = nanoid(6); // 6 character random slug
    } else {
      // Validate custom slug
      if (!/^[a-zA-Z0-9_-]+$/.test(slug) || slug.length > 50) {
        return res.status(400).json({ error: 'Invalid slug format' });
      }
    }
    
    // Check if slug already exists
    const existing = await getUrlBySlug(slug);
    if (existing) {
      return res.status(409).json({ error: 'Slug already in use' });
    }
    
    // Create URL
    const urlRecord = await createUrl(req.user.id, url, slug);
    const domain = await getDomain();
    
    res.status(201).json({
      id: urlRecord.id,
      shortUrl: `${domain}/${slug}`,
      longUrl: url,
      slug: slug,
      createdAt: urlRecord.created_at
    });
  } catch (err) {
    console.error('Create URL error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get URL by slug (public endpoint for redirect service)
app.get('/urls/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const urlRecord = await getUrlBySlug(slug);
    
    if (!urlRecord) {
      return res.status(404).json({ error: 'URL not found' });
    }
    
    // Increment click count asynchronously
    incrementClicks(urlRecord.id).catch(err => 
      console.error('Failed to increment clicks:', err)
    );
    
    res.json({
      longUrl: urlRecord.long_url,
      slug: urlRecord.slug
    });
  } catch (err) {
    console.error('Get URL error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List user's URLs
app.get('/urls', validateApiKey, async (req, res) => {
  try {
    const urls = await getUserUrls(req.user.id);
    const domain = await getDomain();
    
    const formattedUrls = urls.map(u => ({
      id: u.id,
      shortUrl: `${domain}/${u.slug}`,
      longUrl: u.long_url,
      slug: u.slug,
      clicks: u.clicks,
      createdAt: u.created_at
    }));
    
    res.json({ urls: formattedUrls });
  } catch (err) {
    console.error('List URLs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete URL
app.delete('/urls/:slug', validateApiKey, async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Check ownership
    const urlRecord = await getUrlBySlug(slug);
    if (!urlRecord) {
      return res.status(404).json({ error: 'URL not found' });
    }
    
    if (urlRecord.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    await deleteUrl(urlRecord.id);
    res.json({ message: 'URL deleted', slug });
  } catch (err) {
    console.error('Delete URL error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get all URLs
app.get('/admin/urls', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Validate admin key via auth service
    const authResponse = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    
    if (!authResponse.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const authData = await authResponse.json();
    if (authData.userId !== 1) { // Simple admin check - user ID 1
      return res.status(403).json({ error: 'Admin access required' });
    }

    const urls = await getAllUrls();
    const domain = await getDomain();
    
    const formattedUrls = urls.map(u => ({
      id: u.id,
      shortUrl: `${domain}/${u.slug}`,
      longUrl: u.long_url,
      slug: u.slug,
      clicks: u.clicks,
      userId: u.user_id,
      createdAt: u.created_at
    }));
    
    res.json({ urls: formattedUrls });
  } catch (err) {
    console.error('Admin URLs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get URL stats
app.get('/admin/stats', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Validate admin key
    const authResponse = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    
    if (!authResponse.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const authData = await authResponse.json();
    if (authData.userId !== 1) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = await getUrlStats();
    res.json(stats);
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`URL service running on port ${PORT}`);
});