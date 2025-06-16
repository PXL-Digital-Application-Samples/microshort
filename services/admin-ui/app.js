import { Dashboard } from './components/Dashboard.js';
import { Users } from './components/Users.js';
import { URLs } from './components/URLs.js';
import { Config } from './components/Config.js';
import { Health } from './components/Health.js';

export function App(van, html) {
    const { div, nav, button, header, main, h1, span } = van.tags;
    
    // State
    const apiKey = van.state(localStorage.getItem('adminApiKey') || '');
    const currentView = van.state('login');
    const loading = van.state(false);
    const error = van.state('');
    
    // API base URL
    const API_BASE = 'http://localhost:3003';
    
    // API helper
    const apiCall = async (endpoint, options = {}) => {
        if (!apiKey.val) {
            throw new Error('No API key');
        }
        
        loading.val = true;
        error.val = '';
        
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                ...options,
                headers: {
                    'X-API-Key': apiKey.val,
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'API request failed');
            }
            
            return await response.json();
        } catch (err) {
            error.val = err.message;
            throw err;
        } finally {
            loading.val = false;
        }
    };
    
    // Login component
    const Login = () => {
        const inputKey = van.state('');
        
        const handleLogin = async () => {
            if (!inputKey.val) return;
            
            try {
                // Test the API key
                apiKey.val = inputKey.val;
                await apiCall('/admin/dashboard');
                
                // Save and switch view
                localStorage.setItem('adminApiKey', inputKey.val);
                currentView.val = 'dashboard';
            } catch (err) {
                apiKey.val = '';
                error.val = 'Invalid admin API key';
            }
        };
        
        return html`
            <div class="login-container">
                <div class="login-box">
                    <h1>Microshort Admin</h1>
                    <p>Enter your admin API key to continue</p>
                    
                    ${() => error.val && html`<div class="error">${error.val}</div>`}
                    
                    <input 
                        type="password" 
                        placeholder="msh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        value=${inputKey.val}
                        oninput=${e => inputKey.val = e.target.value}
                        onkeypress=${e => e.key === 'Enter' && handleLogin()}
                    />
                    
                    <button onclick=${handleLogin} disabled=${loading.val}>
                        ${() => loading.val ? 'Logging in...' : 'Login'}
                    </button>
                    
                    <p class="hint">
                        First user (ID 1) is admin. Use their API key.
                    </p>
                </div>
            </div>
        `;
    };
    
    // Navigation
    const Navigation = () => html`
        <nav class="main-nav">
            <div class="nav-brand">
                <h2>Microshort Admin</h2>
            </div>
            
            <div class="nav-links">
                <button 
                    class=${() => currentView.val === 'dashboard' ? 'active' : ''}
                    onclick=${() => currentView.val = 'dashboard'}
                >
                    Dashboard
                </button>
                <button 
                    class=${() => currentView.val === 'users' ? 'active' : ''}
                    onclick=${() => currentView.val = 'users'}
                >
                    Users
                </button>
                <button 
                    class=${() => currentView.val === 'urls' ? 'active' : ''}
                    onclick=${() => currentView.val = 'urls'}
                >
                    URLs
                </button>
                <button 
                    class=${() => currentView.val === 'config' ? 'active' : ''}
                    onclick=${() => currentView.val = 'config'}
                >
                    Config
                </button>
                <button 
                    class=${() => currentView.val === 'health' ? 'active' : ''}
                    onclick=${() => currentView.val = 'health'}
                >
                    Health
                </button>
            </div>
            
            <div class="nav-actions">
                <button 
                    class="logout-btn"
                    onclick=${() => {
                        apiKey.val = '';
                        localStorage.removeItem('adminApiKey');
                        currentView.val = 'login';
                    }}
                >
                    Logout
                </button>
            </div>
        </nav>
    `;
    
    // Main layout
    const MainLayout = () => html`
        <div class="app-container">
            ${Navigation()}
            
            <main class="main-content">
                ${() => error.val && html`<div class="error-banner">${error.val}</div>`}
                ${() => loading.val && html`<div class="loading">Loading...</div>`}
                
                ${() => {
                    switch(currentView.val) {
                        case 'dashboard':
                            return Dashboard(van, html, apiCall);
                        case 'users':
                            return Users(van, html, apiCall);
                        case 'urls':
                            return URLs(van, html, apiCall);
                        case 'config':
                            return Config(van, html, apiCall);
                        case 'health':
                            return Health(van, html, apiCall);
                        default:
                            return html`<div>Unknown view</div>`;
                    }
                }}
            </main>
        </div>
    `;
    
    // Check if already logged in
    if (apiKey.val) {
        apiCall('/admin/dashboard')
            .then(() => currentView.val = 'dashboard')
            .catch(() => {
                apiKey.val = '';
                localStorage.removeItem('adminApiKey');
            });
    }
    
    // Root component
    return div(
        { class: 'app' },
        () => currentView.val === 'login' ? Login() : MainLayout()
    );
}
