# Admin UI

Web-based admin dashboard for the microshort platform. Built with VanJS + htm for a zero-build-tool approach.

## Features

- **Dashboard** - System overview with key metrics
- **User Management** - View all registered users
- **URL Management** - Browse, search, and view all shortened URLs
- **Configuration** - Update system settings (domain)
- **Health Monitoring** - Real-time service health checks

## Technology Stack

- **VanJS** - Reactive UI framework (1KB)
- **htm** - JSX-like syntax without transpilation
- **Modern CSS** - No build step, just clean CSS
- **Express** - Simple static file server

## Architecture

This UI is completely client-side and communicates only with the admin-service API:
- No server-side rendering
- No build process required
- All API calls go through admin-service
- Authentication via API key

## Getting Started

### Development
```bash
npm install
npm run dev
```

Access at http://localhost:3004

### First Time Setup

1. Start all microservices
2. Create the admin user (first user is admin):
   ```bash
   curl -X POST http://localhost:3001/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@example.com","password":"admin123"}'
   ```

3. Get an API key for the admin:
   ```bash
   # Login first to get JWT
   TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@example.com","password":"admin123"}' | jq -r .token)
   
   # Generate API key
   curl -X POST http://localhost:3001/auth/api-keys \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"name":"Admin UI Key"}'
   ```

4. Use the API key to login to the admin UI

## Environment Variables

- `PORT` - Server port (default: 3004)

## File Structure

```
admin-ui/
├── index.html          # Main HTML file
├── app.js             # Main app logic
├── components/        # UI components
│   ├── Dashboard.js
│   ├── Users.js
│   ├── URLs.js
│   ├── Config.js
│   └── Health.js
├── styles.css         # All styling
├── server.js          # Express static server
└── package.json
```

## Security Notes

- Admin API key is stored in localStorage
- All requests go through admin-service which validates permissions
- CORS is enabled on admin-service for browser access
- In production, use HTTPS and secure headers

## Browser Support

Works in all modern browsers with ES6 module support:
- Chrome/Edge 61+
- Firefox 60+
- Safari 11+

## Customization

The UI uses CSS custom properties for theming. Modify the `:root` section in `styles.css` to change colors:

```css
:root {
    --primary: #3b82f6;
    --success: #10b981;
    /* etc */
}
```

## Future Enhancements

- Real-time updates via WebSocket
- Bulk operations
- Export functionality
- Advanced filtering and sorting
- Charts and graphs for analytics
- Dark mode
