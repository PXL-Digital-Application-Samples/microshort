export function Config(van, html, apiCall) {
    const currentDomain = van.state('');
    const newDomain = van.state('');
    const loading = van.state(true);
    const saving = van.state(false);
    const message = van.state('');
    
    // Load current config
    const loadConfig = async () => {
        loading.val = true;
        try {
            const data = await apiCall('/admin/config');
            currentDomain.val = data.domain;
            newDomain.val = data.domain;
        } catch (err) {
            console.error('Failed to load config:', err);
        } finally {
            loading.val = false;
        }
    };
    
    // Update config
    const updateConfig = async () => {
        if (!newDomain.val || newDomain.val === currentDomain.val) return;
        
        saving.val = true;
        message.val = '';
        
        try {
            await apiCall('/admin/config', {
                method: 'PUT',
                body: JSON.stringify({ domain: newDomain.val })
            });
            
            currentDomain.val = newDomain.val;
            message.val = 'Configuration updated successfully!';
            
            // Clear message after 3 seconds
            setTimeout(() => message.val = '', 3000);
        } catch (err) {
            message.val = `Error: ${err.message}`;
        } finally {
            saving.val = false;
        }
    };
    
    // Load on mount
    loadConfig();
    
    return html`
        <div class="config-page">
            <div class="page-header">
                <h1>Configuration</h1>
            </div>
            
            ${() => {
                if (loading.val) return html`<div class="loading">Loading configuration...</div>`;
                
                return html`
                    <div class="config-form">
                        <div class="form-section">
                            <h2>Domain Settings</h2>
                            <p class="form-description">
                                Configure the base domain for short URLs. This affects how URLs are displayed to users.
                            </p>
                            
                            ${() => message.val && html`
                                <div class=${message.val.startsWith('Error') ? 'message error' : 'message success'}>
                                    ${message.val}
                                </div>
                            `}
                            
                            <div class="form-group">
                                <label for="domain">Short URL Domain</label>
                                <input 
                                    id="domain"
                                    type="text" 
                                    placeholder="https://example.com"
                                    value=${newDomain.val}
                                    oninput=${e => newDomain.val = e.target.value}
                                />
                                <div class="form-help">
                                    Current: <code>${currentDomain.val}</code>
                                </div>
                            </div>
                            
                            <div class="form-actions">
                                <button 
                                    onclick=${updateConfig}
                                    disabled=${() => saving.val || !newDomain.val || newDomain.val === currentDomain.val}
                                    class="primary-btn"
                                >
                                    ${() => saving.val ? 'Saving...' : 'Update Configuration'}
                                </button>
                                
                                <button 
                                    onclick=${() => newDomain.val = currentDomain.val}
                                    disabled=${saving.val}
                                    class="secondary-btn"
                                >
                                    Reset
                                </button>
                            </div>
                        </div>
                        
                        <div class="form-section">
                            <h2>Configuration Notes</h2>
                            <ul class="config-notes">
                                <li>Changes take effect immediately for new URLs</li>
                                <li>Existing URLs will continue to work</li>
                                <li>Make sure the domain points to the redirect service</li>
                                <li>Use HTTPS in production for security</li>
                            </ul>
                        </div>
                    </div>
                `;
            }}
        </div>
    `;
}
