export function Health(van, html, apiCall) {
    const services = van.state([]);
    const loading = van.state(true);
    const lastCheck = van.state(null);
    
    // Check health
    const checkHealth = async () => {
        loading.val = true;
        try {
            const data = await apiCall('/admin/health/services');
            services.val = data.services || [];
            lastCheck.val = new Date();
        } catch (err) {
            console.error('Failed to check health:', err);
        } finally {
            loading.val = false;
        }
    };
    
    // Auto-refresh every 30 seconds
    let refreshInterval;
    const startAutoRefresh = () => {
        refreshInterval = setInterval(checkHealth, 30000);
    };
    
    const stopAutoRefresh = () => {
        if (refreshInterval) {
            clearInterval(refreshInterval);
        }
    };
    
    // Load on mount and start auto-refresh
    checkHealth();
    startAutoRefresh();
    
    // Cleanup on unmount (when view changes)
    van.derive(() => {
        return () => stopAutoRefresh();
    });
    
    const getStatusIcon = (status) => {
        switch(status) {
            case 'healthy':
                return '✅';
            case 'unhealthy':
                return '⚠️';
            case 'unreachable':
                return '❌';
            default:
                return '❓';
        }
    };
    
    const getStatusClass = (status) => {
        switch(status) {
            case 'healthy':
                return 'status-healthy';
            case 'unhealthy':
                return 'status-unhealthy';
            case 'unreachable':
                return 'status-unreachable';
            default:
                return 'status-unknown';
        }
    };
    
    return html`
        <div class="health-page">
            <div class="page-header">
                <h1>Service Health</h1>
                <div class="header-actions">
                    ${() => lastCheck.val && html`
                        <span class="last-check">
                            Last check: ${lastCheck.val.toLocaleTimeString()}
                        </span>
                    `}
                    <button onclick=${checkHealth} class="refresh-btn" disabled=${loading.val}>
                        ${() => loading.val ? 'Checking...' : 'Check Now'}
                    </button>
                </div>
            </div>
            
            ${() => {
                if (loading.val && services.val.length === 0) {
                    return html`<div class="loading">Checking service health...</div>`;
                }
                
                if (services.val.length === 0) {
                    return html`<div class="empty-state">No service data available</div>`;
                }
                
                const healthyCount = services.val.filter(s => s.status === 'healthy').length;
                const totalCount = services.val.length;
                
                return html`
                    <div class="health-overview">
                        <div class="health-summary">
                            <h2>System Status</h2>
                            <div class=${healthyCount === totalCount ? 'summary-good' : 'summary-bad'}>
                                ${healthyCount === totalCount 
                                    ? '✅ All systems operational' 
                                    : `⚠️ ${totalCount - healthyCount} service(s) having issues`
                                }
                            </div>
                        </div>
                        
                        <div class="services-grid">
                            ${services.val.map(service => html`
                                <div class=${`service-card ${getStatusClass(service.status)}`}>
                                    <div class="service-header">
                                        <span class="service-icon">${getStatusIcon(service.status)}</span>
                                        <h3>${service.service.charAt(0).toUpperCase() + service.service.slice(1)} Service</h3>
                                    </div>
                                    
                                    <div class="service-status">
                                        Status: <strong>${service.status}</strong>
                                    </div>
                                    
                                    ${service.error && html`
                                        <div class="service-error">
                                            Error: ${service.error}
                                        </div>
                                    `}
                                    
                                    ${service.responseTime && html`
                                        <div class="service-response">
                                            Response time: ${service.responseTime}
                                        </div>
                                    `}
                                </div>
                            `)}
                        </div>
                        
                        <div class="health-info">
                            <p>
                                <strong>Auto-refresh:</strong> Health checks run automatically every 30 seconds.
                            </p>
                            <p>
                                <strong>Service ports:</strong> 
                                Config (3000), Auth (3001), URL (3002), Admin (3003), Redirect (8080)
                            </p>
                        </div>
                    </div>
                `;
            }}
        </div>
    `;
}
