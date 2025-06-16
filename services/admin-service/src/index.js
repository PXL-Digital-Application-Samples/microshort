import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3003;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
const URL_SERVICE_URL = process.env.URL_SERVICE_URL || 'http://url-service:3002';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';

app.use(cors());
app.use(express.json());

// Validate admin API key middleware
async function validateAdminKey(req, res, next) {
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
    
    // Simple admin check - user ID 1 is admin
    if (data.userId !== 1) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    req.admin = { id: data.userId };
    next();
  } catch (err) {
    console.error('Admin auth validation error:', err);
    res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Get dashboard overview
app.get('/admin/dashboard', validateAdminKey, async (req, res) => {
  try {
    // Fetch stats from both services in parallel
    const [authStatsRes, urlStatsRes] = await Promise.all([
      fetch(`${AUTH_SERVICE_URL}/admin/stats`, {
        headers: { 'X-API-Key': req.headers['x-api-key'] }
      }),
      fetch(`${URL_SERVICE_URL}/admin/stats`, {
        headers: { 'X-API-Key': req.headers['x-api-key'] }
      })
    ]);
    
    if (!authStatsRes.ok || !urlStatsRes.ok) {
      throw new Error('Failed to fetch stats');
    }
    
    const authStats = await authStatsRes.json();
    const urlStats = await urlStatsRes.json();
    
    res.json({
      users: {
        total: authStats.totalUsers,
        recentSignups: authStats.recentUsers,
        totalApiKeys: authStats.totalApiKeys
      },
      urls: {
        total: urlStats.totalUrls,
        totalClicks: urlStats.totalClicks,
        recentUrls: urlStats.recentUrls,
        topUrls: urlStats.topUrls
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// List all users
app.get('/admin/users', validateAdminKey, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/admin/users`, {
      headers: { 'X-API-Key': req.headers['x-api-key'] }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch users');
    }
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// List all URLs
app.get('/admin/urls', validateAdminKey, async (req, res) => {
  try {
    const response = await fetch(`${URL_SERVICE_URL}/admin/urls`, {
      headers: { 'X-API-Key': req.headers['x-api-key'] }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch URLs');
    }
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('URLs list error:', err);
    res.status(500).json({ error: 'Failed to fetch URLs' });
  }
});

// Get user details with their URLs
app.get('/admin/users/:userId', validateAdminKey, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user URLs by making a request as that user
    // Note: This is a workaround since we don't have a direct endpoint
    // In production, you'd want a proper admin endpoint
    
    res.status(501).json({ 
      error: 'User details endpoint not implemented',
      note: 'Would need additional endpoints in auth-service and url-service'
    });
  } catch (err) {
    console.error('User details error:', err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Update configuration
app.put('/admin/config', validateAdminKey, async (req, res) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain required' });
    }
    
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });
    
    if (!response.ok) {
      throw new Error('Failed to update config');
    }
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Config update error:', err);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Get current configuration
app.get('/admin/config', validateAdminKey, async (req, res) => {
  try {
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`);
    
    if (!response.ok) {
      throw new Error('Failed to fetch config');
    }
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Search URLs
app.get('/admin/search/urls', validateAdminKey, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }
    
    // Get all URLs and filter client-side
    // In production, you'd want a proper search endpoint
    const response = await fetch(`${URL_SERVICE_URL}/admin/urls`, {
      headers: { 'X-API-Key': req.headers['x-api-key'] }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch URLs');
    }
    
    const data = await response.json();
    const filtered = data.urls.filter(url => 
      url.slug.includes(q) || 
      url.longUrl.includes(q)
    );
    
    res.json({ urls: filtered });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// System health check
app.get('/admin/health/services', validateAdminKey, async (req, res) => {
  try {
    const services = [
      { name: 'auth', url: `${AUTH_SERVICE_URL}/health` },
      { name: 'url', url: `${URL_SERVICE_URL}/health` },
      { name: 'config', url: `${CONFIG_SERVICE_URL}/health` }
    ];
    
    const healthChecks = await Promise.all(
      services.map(async (service) => {
        try {
          const response = await fetch(service.url, { timeout: 2000 });
          return {
            service: service.name,
            status: response.ok ? 'healthy' : 'unhealthy',
            responseTime: response.headers.get('x-response-time') || 'N/A'
          };
        } catch (err) {
          return {
            service: service.name,
            status: 'unreachable',
            error: err.message
          };
        }
      })
    );
    
    res.json({ services: healthChecks });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Admin service running on port ${PORT}`);
});
