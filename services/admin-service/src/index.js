import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3003;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
const URL_SERVICE_URL = process.env.URL_SERVICE_URL || 'http://url-service:3002';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';

const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3005';
const SERVICE_TOKEN         = process.env.SERVICE_TOKEN          || '';

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
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const data = await response.json();

    // Check pre-computed isAdmin property from auth-service
    if (!data.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    req.admin = { id: data.userId, role: data.role };
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
    const [authStatsRes, urlStatsRes, analyticsOverviewRes, analyticsTopRes] = await Promise.all([
      fetch(`${AUTH_SERVICE_URL}/admin/stats`, {
        headers: { 'X-API-Key': req.headers['x-api-key'] },
        signal: AbortSignal.timeout(2000)
      }),
      fetch(`${URL_SERVICE_URL}/admin/stats`, {
        headers: { 'X-API-Key': req.headers['x-api-key'] },
        signal: AbortSignal.timeout(2000)
      }),
      fetch(`${ANALYTICS_SERVICE_URL}/stats/overview`, {
        headers: { 'X-Service-Token': SERVICE_TOKEN },
        signal: AbortSignal.timeout(2000)
      }),
      fetch(`${ANALYTICS_SERVICE_URL}/stats/top?limit=10`, {
        headers: { 'X-Service-Token': SERVICE_TOKEN },
        signal: AbortSignal.timeout(2000)
      })
    ]);

    if (!authStatsRes.ok || !urlStatsRes.ok || !analyticsOverviewRes.ok || !analyticsTopRes.ok) {
      throw new Error('Failed to fetch stats from upstream services');
    }

    const authStats        = await authStatsRes.json();
    const urlStats         = await urlStatsRes.json();
    const analyticsOverview = await analyticsOverviewRes.json();
    const analyticsTop     = await analyticsTopRes.json();

    res.json({
      users: {
        total:        authStats.totalUsers,
        recentSignups: authStats.recentUsers,
        totalApiKeys: authStats.totalApiKeys
      },
      urls: {
        total:       urlStats.totalUrls,
        recentUrls:  urlStats.recentUrls,
        // Click metrics sourced from analytics-service (authoritative)
        totalClicks: analyticsOverview.totalClicks,
        topUrls:     analyticsTop.map(t => ({ slug: t.slug, clicks: t.totalClicks }))
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
      headers: { 'X-API-Key': req.headers['x-api-key'] },
      signal: AbortSignal.timeout(2000)
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
      headers: { 'X-API-Key': req.headers['x-api-key'] },
      signal: AbortSignal.timeout(2000)
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
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': process.env.CONFIG_WRITE_TOKEN || ''
      },
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(2000)
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
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, { signal: AbortSignal.timeout(2000) });

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
      headers: { 'X-API-Key': req.headers['x-api-key'] },
      signal: AbortSignal.timeout(2000)
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
      { name: 'auth',      url: `${AUTH_SERVICE_URL}/health` },
      { name: 'url',       url: `${URL_SERVICE_URL}/health` },
      { name: 'config',    url: `${CONFIG_SERVICE_URL}/health` },
      { name: 'analytics', url: `${ANALYTICS_SERVICE_URL}/actuator/health/liveness` }
    ];
    
    const healthChecks = await Promise.all(
      services.map(async (service) => {
        try {
          const response = await fetch(service.url, { signal: AbortSignal.timeout(2000) });
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
