export function Dashboard(van, html, apiCall) {
    const stats = van.state(null);
    
    // Load dashboard data
    const loadDashboard = async () => {
        try {
            const data = await apiCall('/admin/dashboard');
            stats.val = data;
        } catch (err) {
            console.error('Failed to load dashboard:', err);
        }
    };
    
    // Load on mount
    loadDashboard();
    
    const StatCard = ({ title, value, subtitle }) => html`
        <div class="stat-card">
            <h3>${title}</h3>
            <div class="stat-value">${value}</div>
            ${subtitle && html`<div class="stat-subtitle">${subtitle}</div>`}
        </div>
    `;
    
    const TopURLsList = ({ urls }) => html`
        <div class="top-urls">
            <h3>Top URLs by Clicks</h3>
            <div class="url-list">
                ${urls.length === 0 
                    ? html`<p>No URLs yet</p>`
                    : urls.map(url => html`
                        <div class="url-item">
                            <span class="url-slug">${url.slug}</span>
                            <span class="url-clicks">${url.clicks} clicks</span>
                            <div class="url-long">${url.long_url}</div>
                        </div>
                    `)
                }
            </div>
        </div>
    `;
    
    return html`
        <div class="dashboard">
            <div class="page-header">
                <h1>Dashboard</h1>
                <button onclick=${loadDashboard} class="refresh-btn">
                    Refresh
                </button>
            </div>
            
            ${() => {
                if (!stats.val) return html`<div class="loading">Loading dashboard...</div>`;
                
                const { users, urls } = stats.val;
                
                return html`
                    <div class="stats-grid">
                        ${StatCard({
                            title: 'Total Users',
                            value: users.total,
                            subtitle: `${users.recentSignups} new this week`
                        })}
                        
                        ${StatCard({
                            title: 'Total URLs',
                            value: urls.total,
                            subtitle: `${urls.recentUrls} created this week`
                        })}
                        
                        ${StatCard({
                            title: 'Total Clicks',
                            value: urls.totalClicks,
                            subtitle: 'All time'
                        })}
                        
                        ${StatCard({
                            title: 'API Keys',
                            value: users.totalApiKeys,
                            subtitle: 'Active keys'
                        })}
                    </div>
                    
                    <div class="dashboard-content">
                        ${TopURLsList({ urls: urls.topUrls || [] })}
                    </div>
                `;
            }}
        </div>
    `;
}
