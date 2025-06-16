import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3004;

// Serve static files
app.use(express.static(__dirname));

// SPA fallback - always serve index.html for any route
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Admin UI running on port ${PORT}`);
    console.log(`Access the admin UI at http://localhost:${PORT}`);
});
