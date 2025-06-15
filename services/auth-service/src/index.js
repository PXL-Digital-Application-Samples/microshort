import express from 'express';
import cors from 'cors';
import { createUser, findUserByEmail, createApiKey, validateApiKey, getUserApiKeys, revokeApiKey } from './db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

app.use(cors());
app.use(express.json());

// JWT verification middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Register new user
app.post('/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(email, passwordHash);
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: user.id });
  } catch (err) {
    if (err.message.includes('duplicate key')) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: user.id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user profile
app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const user = await findUserByEmail(req.user.email);
    res.json({ 
      id: user.id,
      email: user.email,
      createdAt: user.created_at
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate API key
app.post('/auth/api-keys', verifyToken, async (req, res) => {
  try {
    const { name } = req.body;
    const apiKey = await createApiKey(req.user.userId, name || 'Unnamed key');
    
    res.json({ 
      apiKey: apiKey.key,
      keyId: apiKey.id,
      name: apiKey.name 
    });
  } catch (err) {
    console.error('API key generation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Validate API key (for other services to use)
app.post('/auth/validate', async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({ error: 'API key required' });
    }

    const keyData = await validateApiKey(apiKey);
    if (!keyData) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    res.json({ 
      valid: true, 
      userId: keyData.user_id,
      keyId: keyData.id 
    });
  } catch (err) {
    console.error('Validation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List user's API keys
app.get('/auth/api-keys', verifyToken, async (req, res) => {
  try {
    const keys = await getUserApiKeys(req.user.userId);
    
    // Don't return the actual key values, just metadata
    const safeKeys = keys.map(k => ({
      id: k.id,
      name: k.name,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at
    }));
    
    res.json({ keys: safeKeys });
  } catch (err) {
    console.error('List keys error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke an API key
app.delete('/auth/api-keys/:keyId', verifyToken, async (req, res) => {
  try {
    const keyId = parseInt(req.params.keyId);
    
    if (isNaN(keyId)) {
      return res.status(400).json({ error: 'Invalid key ID' });
    }
    
    const result = await revokeApiKey(req.user.userId, keyId);
    if (!result) {
      return res.status(404).json({ error: 'API key not found' });
    }
    
    res.json({ message: 'API key revoked', keyId: result.id });
  } catch (err) {
    console.error('Revoke key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
});