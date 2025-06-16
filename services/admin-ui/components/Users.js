export function Users(van, html, apiCall) {
    const users = van.state([]);
    const loading = van.state(true);
    
    // Load users
    const loadUsers = async () => {
        loading.val = true;
        try {
            const data = await apiCall('/admin/users');
            users.val = data.users || [];
        } catch (err) {
            console.error('Failed to load users:', err);
        } finally {
            loading.val = false;
        }
    };
    
    // Load on mount
    loadUsers();
    
    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleString();
    };
    
    return html`
        <div class="users-page">
            <div class="page-header">
                <h1>Users</h1>
                <button onclick=${loadUsers} class="refresh-btn">
                    Refresh
                </button>
            </div>
            
            ${() => {
                if (loading.val) return html`<div class="loading">Loading users...</div>`;
                
                if (users.val.length === 0) {
                    return html`<div class="empty-state">No users found</div>`;
                }
                
                return html`
                    <div class="data-table">
                        <table>
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>Email</th>
                                    <th>Created</th>
                                    <th>Role</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${users.val.map(user => html`
                                    <tr>
                                        <td>${user.id}</td>
                                        <td>${user.email}</td>
                                        <td>${formatDate(user.createdAt)}</td>
                                        <td>
                                            <span class=${user.id === 1 ? 'badge badge-admin' : 'badge'}>
                                                ${user.id === 1 ? 'Admin' : 'User'}
                                            </span>
                                        </td>
                                    </tr>
                                `)}
                            </tbody>
                        </table>
                    </div>
                    
                    <div class="table-footer">
                        Total: ${users.val.length} users
                    </div>
                `;
            }}
        </div>
    `;
}
