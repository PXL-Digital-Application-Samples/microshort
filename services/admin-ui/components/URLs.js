export function URLs(van, html, apiCall) {
    const urls = van.state([]);
    const loading = van.state(true);
    const searchQuery = van.state('');
    const filteredUrls = van.state([]);
    
    // Load URLs
    const loadUrls = async () => {
        loading.val = true;
        try {
            const data = await apiCall('/admin/urls');
            urls.val = data.urls || [];
            filterUrls();
        } catch (err) {
            console.error('Failed to load URLs:', err);
        } finally {
            loading.val = false;
        }
    };
    
    // Filter URLs based on search
    const filterUrls = () => {
        const query = searchQuery.val.toLowerCase();
        if (!query) {
            filteredUrls.val = urls.val;
        } else {
            filteredUrls.val = urls.val.filter(url => 
                url.slug.toLowerCase().includes(query) ||
                url.longUrl.toLowerCase().includes(query)
            );
        }
    };
    
    // Watch search query
    van.derive(() => {
        searchQuery.val; // trigger on change
        filterUrls();
    });
    
    // Load on mount
    loadUrls();
    
    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleString();
    };
    
    const truncateUrl = (url, maxLength = 50) => {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength) + '...';
    };
    
    return html`
        <div class="urls-page">
            <div class="page-header">
                <h1>URLs</h1>
                <div class="header-actions">
                    <input 
                        type="text" 
                        placeholder="Search URLs..." 
                        class="search-input"
                        value=${searchQuery.val}
                        oninput=${e => searchQuery.val = e.target.value}
                    />
                    <button onclick=${loadUrls} class="refresh-btn">
                        Refresh
                    </button>
                </div>
            </div>
            
            ${() => {
                if (loading.val) return html`<div class="loading">Loading URLs...</div>`;
                
                const urlsToShow = filteredUrls.val;
                
                if (urlsToShow.length === 0) {
                    return html`
                        <div class="empty-state">
                            ${searchQuery.val 
                                ? 'No URLs match your search' 
                                : 'No URLs created yet'}
                        </div>
                    `;
                }
                
                return html`
                    <div class="data-table">
                        <table>
                            <thead>
                                <tr>
                                    <th>Slug</th>
                                    <th>Destination</th>
                                    <th>Clicks</th>
                                    <th>User ID</th>
                                    <th>Created</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${urlsToShow.map(url => html`
                                    <tr>
                                        <td>
                                            <code>${url.slug}</code>
                                        </td>
                                        <td class="url-cell">
                                            <a href=${url.longUrl} target="_blank" title=${url.longUrl}>
                                                ${truncateUrl(url.longUrl)}
                                            </a>
                                        </td>
                                        <td>${url.clicks}</td>
                                        <td>${url.userId}</td>
                                        <td>${formatDate(url.createdAt)}</td>
                                        <td>
                                            <a 
                                                href=${url.shortUrl} 
                                                target="_blank" 
                                                class="action-link"
                                            >
                                                Visit →
                                            </a>
                                        </td>
                                    </tr>
                                `)}
                            </tbody>
                        </table>
                    </div>
                    
                    <div class="table-footer">
                        Showing ${urlsToShow.length} of ${urls.val.length} URLs
                    </div>
                `;
            }}
        </div>
    `;
}
