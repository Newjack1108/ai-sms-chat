// Common JavaScript functions for production system

const API_BASE = '/production/api';

// API helper function
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        
        // Handle authentication errors first
        if (response.status === 401 || response.status === 403) {
            // Don't try to parse, just redirect
            window.location.href = '/production/login.html';
            return null;
        }
        
        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        let data;
        
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('Non-JSON response from', endpoint, ':', text.substring(0, 200));
            
            // Try to parse as JSON anyway (some servers don't set content-type correctly)
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw new Error(`Server returned HTML instead of JSON (${response.status}): ${response.statusText}. Check if the API endpoint exists.`);
            }
        } else {
            data = await response.json();
        }
        
        if (!response.ok) {
            // Check if it's an auth error in the JSON response
            if (data.requiresLogin || response.status === 401 || response.status === 403) {
                window.location.href = '/production/login.html';
                return null;
            }
            throw new Error(data.error || 'Request failed');
        }
        
        return data;
    } catch (error) {
        console.error('API call error:', error);
        throw error;
    }
}

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/me`);
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                window.location.href = '/production/login.html';
                return null;
            }
            // For other errors, try to parse JSON
            try {
                const data = await response.json();
                if (data.requiresLogin) {
                    window.location.href = '/production/login.html';
                    return null;
                }
            } catch (e) {
                // If not JSON, just redirect
                window.location.href = '/production/login.html';
                return null;
            }
        }
        const data = await response.json();
        return data.user;
    } catch (error) {
        // Only redirect on network/auth errors, not on JSON parse errors
        if (error.message && error.message.includes('JSON')) {
            console.error('Auth check failed:', error);
            return null;
        }
        window.location.href = '/production/login.html';
        return null;
    }
}

// Logout
async function logout() {
    try {
        await apiCall('/logout', { method: 'POST' });
        window.location.href = '/production/login.html';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/production/login.html';
    }
}

// Format currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP'
    }).format(amount || 0);
}

// Format date
function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

// Format datetime
function formatDateTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Show alert
function showAlert(message, type = 'success') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    const container = document.querySelector('.container') || document.body;
    container.insertBefore(alertDiv, container.firstChild);
    
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

// Show modal
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
    }
}

// Hide modal
function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

// Close modal on outside click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
    }
});

// Initialize navbar
async function initNavbar() {
    const user = await checkAuth();
    if (user) {
        const userInfo = document.getElementById('userInfo');
        if (userInfo) {
            userInfo.textContent = `${user.username} (${user.role})`;
        }
        
        // Hide admin-only menu items
        if (user.role !== 'admin') {
            const adminItems = document.querySelectorAll('.admin-only');
            adminItems.forEach(item => item.style.display = 'none');
        }
    }
}

