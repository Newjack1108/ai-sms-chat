// Common JavaScript functions for production system

const API_BASE = '/production/api';

// API helper function
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            credentials: 'same-origin', // Include cookies for session
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
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
        let text;
        
        // Clone response to read as text first (in case we need to check if it's HTML)
        if (!contentType || !contentType.includes('application/json')) {
            text = await response.text();
            console.error('Non-JSON response from', endpoint, 'Status:', response.status, 'Content:', text.substring(0, 200));
            
            // Try to parse as JSON anyway (some servers don't set content-type correctly)
            try {
                data = JSON.parse(text);
            } catch (e) {
                // If it's HTML, it's likely a 404 or error page
                if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
                    throw new Error(`Server returned HTML page (${response.status}): ${response.statusText}. The API endpoint may not exist or there was a server error.`);
                }
                throw new Error(`Server returned non-JSON response (${response.status}): ${response.statusText}`);
            }
        } else {
            // Read as JSON
            try {
                data = await response.json();
            } catch (e) {
                // If JSON parsing fails, try reading as text
                text = await response.clone().text();
                console.error('JSON parse failed, response text:', text.substring(0, 200));
                throw new Error(`Failed to parse JSON response: ${e.message}`);
            }
        }
        
        if (!response.ok) {
            // Check if it's an auth error in the JSON response
            if (data && (data.requiresLogin || response.status === 401 || response.status === 403)) {
                window.location.href = '/production/login.html';
                return null;
            }
            
            // Extract error message - check multiple possible fields
            let errorMessage = data?.error || data?.message || data?.detail;
            if (!errorMessage && response.status === 500) {
                errorMessage = 'Internal server error occurred';
            }
            if (!errorMessage) {
                errorMessage = `Request failed with status ${response.status}: ${response.statusText}`;
            }
            
            throw new Error(errorMessage);
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

// Escape HTML to prevent XSS attacks
function escapeHtml(text) {
    if (text == null || text === undefined) {
        return '';
    }
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
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

// Check if user is staff and redirect to timesheet if they try to access restricted pages
async function restrictStaffAccess() {
    const user = await checkAuth();
    if (user && user.role === 'staff') {
        // Staff can access timesheet, tasks, reminders, and holidays pages
        const allowedPages = ['timesheet.html', 'tasks.html', 'reminders.html', 'holidays.html', 'login.html'];
        const currentPage = window.location.pathname.split('/').pop();
        
        if (!allowedPages.includes(currentPage) && !window.location.pathname.includes('login.html')) {
            window.location.href = '/production/timesheet.html';
            return true;
        }
    }
    return false;
}

// Initialize navbar
async function initNavbar() {
    const user = await checkAuth();
    if (user) {
        const userInfo = document.getElementById('userInfo');
        if (userInfo) {
            userInfo.textContent = `${user.username} (${user.role})`;
        }
        
        // Hide admin-only menu items for non-admin users
        if (user.role !== 'admin') {
            const adminItems = document.querySelectorAll('.admin-only');
            adminItems.forEach(item => item.style.display = 'none');
        }
        
        // Hide admin-or-office items for staff (including items within dropdowns)
        if (user.role === 'staff') {
            const adminOrOfficeItems = document.querySelectorAll('.admin-or-office');
            adminOrOfficeItems.forEach(item => {
                // Check if it's a dropdown container - if so, hide the whole dropdown
                if (item.classList.contains('navbar-dropdown')) {
                    item.style.display = 'none';
                } else {
                    // Otherwise hide the individual item
                    item.style.display = 'none';
                }
            });
        }
        
        // Hide manager-only items for staff (legacy support)
        if (user.role === 'staff') {
            const managerItems = document.querySelectorAll('.manager-only');
            managerItems.forEach(item => item.style.display = 'none');
        }
        
        // Show office-only items only for office and admin
        if (user.role !== 'admin' && user.role !== 'office') {
            const officeOnlyItems = document.querySelectorAll('.office-only');
            officeOnlyItems.forEach(item => item.style.display = 'none');
        }
    }
}

// Dropdown functionality
function toggleDropdown(event, button) {
    event.stopPropagation();
    
    // Close all other dropdowns
    const allDropdowns = document.querySelectorAll('.dropdown-menu');
    const allButtons = document.querySelectorAll('.dropdown-toggle');
    
    allDropdowns.forEach(menu => {
        if (menu !== button.nextElementSibling) {
            menu.classList.remove('show');
        }
    });
    
    allButtons.forEach(btn => {
        if (btn !== button) {
            btn.classList.remove('open');
        }
    });
    
    // Toggle current dropdown
    const menu = button.nextElementSibling;
    if (menu && menu.classList.contains('dropdown-menu')) {
        menu.classList.toggle('show');
        button.classList.toggle('open');
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
    if (!event.target.closest('.navbar-dropdown')) {
        const allDropdowns = document.querySelectorAll('.dropdown-menu');
        const allButtons = document.querySelectorAll('.dropdown-toggle');
        
        allDropdowns.forEach(menu => menu.classList.remove('show'));
        allButtons.forEach(btn => btn.classList.remove('open'));
    }
});

// Default working hours: 8am start; 5pm end Mon-Thu/Sat/Sun, 3pm end Friday
function getDefaultWorkTimes(date) {
    const d = date instanceof Date ? date : new Date(date);
    const isFriday = d.getDay() === 5;
    return { start: '08:00', end: isFriday ? '15:00' : '17:00' };
}