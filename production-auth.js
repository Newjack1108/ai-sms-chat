// Production Authentication Middleware
const bcrypt = require('bcrypt');
const { ProductionDatabase } = require('./production-database');

// Middleware to check if user is authenticated (production session)
function requireProductionAuth(req, res, next) {
    if (req.session && req.session.production_authenticated && req.session.production_user) {
        return next();
    }
    
    // Check if this is an API route
    // Routes in production-routes.js are mounted at /production/api, so originalUrl will contain that
    // Or check if request expects JSON (API calls)
    const isApiRoute = (req.originalUrl && req.originalUrl.startsWith('/production/api/')) ||
                       (req.baseUrl && req.baseUrl.includes('/production/api')) ||
                       req.get('Accept')?.includes('application/json') ||
                       (req.method !== 'GET' && req.get('Content-Type')?.includes('application/json'));
    
    if (isApiRoute) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required',
            requiresLogin: true
        });
    }
    
    // For HTML pages, redirect to login
    return res.redirect('/production/login.html');
}

/** Installer field rights: true installers, plus admins covering installer jobs. */
function hasInstallerRights(role) {
    return role === 'installer' || role === 'admin';
}

// Middleware to check if user is admin
function requireAdmin(req, res, next) {
    if (req.session && req.session.production_user && req.session.production_user.role === 'admin') {
        return next();
    }
    
    return res.status(403).json({
        success: false,
        error: 'Admin privileges required'
    });
}

// Middleware to check if user is office
function requireOffice(req, res, next) {
    if (req.session && req.session.production_user && req.session.production_user.role === 'office') {
        return next();
    }
    
    return res.status(403).json({
        success: false,
        error: 'Office privileges required'
    });
}

// Middleware to check if user is admin or office (clock admin, holiday admin, etc.)
function requireAdminOrOffice(req, res, next) {
    if (req.session && req.session.production_user && 
        (req.session.production_user.role === 'admin' || req.session.production_user.role === 'office')) {
        return next();
    }
    
    return res.status(403).json({
        success: false,
        error: 'Admin or Office privileges required'
    });
}

// Middleware: admin, office, or supervisor (production writes + payroll)
function requireAdminOfficeOrSupervisor(req, res, next) {
    if (req.session && req.session.production_user &&
        (req.session.production_user.role === 'admin' ||
         req.session.production_user.role === 'office' ||
         req.session.production_user.role === 'supervisor')) {
        return next();
    }

    return res.status(403).json({
        success: false,
        error: 'Admin, Office, or Supervisor privileges required'
    });
}

/** Catalog basics: admin, office, supervisor, and the Grok bot role. */
function requireBasicsEditor(req, res, next) {
    const role = req.session && req.session.production_user && req.session.production_user.role;
    if (role === 'admin' || role === 'office' || role === 'supervisor' || role === 'bot') {
        return next();
    }

    return res.status(403).json({
        success: false,
        error: 'Catalog edit privileges required'
    });
}

/**
 * Grok bot may read and edit catalog basics only:
 * raw materials, components, built items, products, suppliers, and WIP.
 * Stock/build movements, sales push, payroll, orders, and user admin stay closed.
 */
function isBotBasicsAllowed(method, path) {
    const p = (path || '/').split('?')[0];
    const m = (method || 'GET').toUpperCase();
    if (m === 'GET' && p === '/me') return true;
    if (m === 'POST' && (p === '/login' || p === '/logout')) return true;
    if (m === 'GET' && p === '/wip') return true;
    if (m === 'GET' && /^\/settings\/[^/]+$/.test(p)) return true;

    if (p === '/stock/low-stock' && m === 'GET') return true;
    if (p === '/stock/categories' && m === 'GET') return true;
    if (p === '/stock' && (m === 'GET' || m === 'POST')) return true;
    if (/^\/stock\/\d+$/.test(p) && (m === 'GET' || m === 'PUT' || m === 'DELETE')) return true;
    if (/^\/stock\/\d+\/suppliers$/.test(p) && (m === 'GET' || m === 'PUT')) return true;
    if (/^\/stock\/\d+\/suppliers\/preferred$/.test(p) && m === 'PUT') return true;
    if (/^\/stock\/\d+\/movements$/.test(p) && m === 'GET') return true;

    if (p === '/components' && (m === 'GET' || m === 'POST')) return true;
    if (/^\/components\/\d+$/.test(p) && (m === 'GET' || m === 'PUT' || m === 'DELETE')) return true;
    if (/^\/components\/\d+\/bom$/.test(p) && (m === 'GET' || m === 'POST')) return true;
    if (/^\/components\/\d+\/bom\/\d+$/.test(p) && m === 'DELETE') return true;
    if (/^\/components\/\d+\/(cost|true-cost|movements)$/.test(p) && m === 'GET') return true;

    if (p === '/panels' && (m === 'GET' || m === 'POST')) return true;
    if (/^\/panels\/\d+$/.test(p) && (m === 'GET' || m === 'PUT' || m === 'DELETE')) return true;
    if (/^\/panels\/\d+\/duplicate$/.test(p) && m === 'POST') return true;
    if (/^\/panels\/\d+\/bom$/.test(p) && (m === 'GET' || m === 'POST')) return true;
    if (/^\/panels\/\d+\/bom\/\d+$/.test(p) && m === 'DELETE') return true;
    if (/^\/panels\/\d+\/(bom-value|true-cost|movements)$/.test(p) && m === 'GET') return true;

    if (p === '/products' && (m === 'GET' || m === 'POST')) return true;
    if (p === '/products/export' && m === 'GET') return true;
    if (/^\/products\/\d+$/.test(p) && (m === 'GET' || m === 'PUT' || m === 'DELETE')) return true;
    if (/^\/products\/\d+\/suppliers$/.test(p) && (m === 'GET' || m === 'PUT')) return true;
    if (/^\/products\/\d+\/components$/.test(p) && (m === 'GET' || m === 'POST')) return true;
    if (/^\/products\/\d+\/components\/\d+$/.test(p) && (m === 'PUT' || m === 'DELETE')) return true;
    if (/^\/products\/\d+\/cost$/.test(p) && m === 'GET') return true;
    if (/^\/products\/\d+\/cost\/refresh$/.test(p) && m === 'POST') return true;
    if (/^\/products\/\d+\/duplicate$/.test(p) && m === 'POST') return true;
    if (/^\/products\/\d+\/requirements$/.test(p) && m === 'GET') return true;

    if (p === '/suppliers' && (m === 'GET' || m === 'POST')) return true;
    if (/^\/suppliers\/\d+$/.test(p) && (m === 'GET' || m === 'PUT' || m === 'DELETE')) return true;

    return false;
}

/** Grok bot: catalog basics only. Other roles are unchanged. */
function restrictBotToBasics(req, res, next) {
    const role = req.session && req.session.production_user && req.session.production_user.role;
    if (role !== 'bot') {
        return next();
    }
    if (isBotBasicsAllowed(req.method, req.path)) {
        return next();
    }
    return res.status(403).json({
        success: false,
        error: 'Grok Bot can only read and edit catalog basics'
    });
}

// Legacy helper (unused): previously blocked supervisors from tasks/reminders.
function denySupervisor(req, res, next) {
    if (req.session && req.session.production_user &&
        req.session.production_user.role === 'supervisor') {
        return res.status(403).json({
            success: false,
            error: 'Supervisors cannot access tasks or reminders'
        });
    }
    return next();
}

/** Paths office may use for calendar view + create booking only. */
function isOfficeCalendarAllowed(method, path) {
    const p = (path || '/').split('?')[0];
    if (method === 'GET' && p === '/me') return true;
    if (method === 'POST' && p === '/login') return true;
    if (method === 'POST' && p === '/logout') return true;
    if (method === 'GET' && p === '/installations') return true;
    if (method === 'POST' && p === '/installations') return true;
    if (method === 'POST' && p === '/installations/check-availability') return true;
    if (method === 'GET' && p === '/orders/for-select') return true;
    if (method === 'GET' && p === '/users') return true;
    if (method === 'GET' && p === '/holidays/calendar') return true;
    if (method === 'GET' && /^\/installations\/\d+$/.test(p)) return true;
    return false;
}

/** Office: installation calendar view/create only; block payroll and all other APIs. */
function restrictOfficeToCalendarBooking(req, res, next) {
    const role = req.session && req.session.production_user && req.session.production_user.role;
    if (role !== 'office') {
        return next();
    }
    if (isOfficeCalendarAllowed(req.method, req.path)) {
        return next();
    }
    return res.status(403).json({
        success: false,
        error: 'Office users can only access the installation calendar'
    });
}

// Legacy middleware - kept for backward compatibility (maps manager to office)
function requireManager(req, res, next) {
    if (req.session && req.session.production_user && 
        (req.session.production_user.role === 'admin' || 
         req.session.production_user.role === 'office' || 
         req.session.production_user.role === 'supervisor' ||
         req.session.production_user.role === 'manager')) {
        return next();
    }
    
    return res.status(403).json({
        success: false,
        error: 'Manager or Admin privileges required'
    });
}

// Login function
async function loginProductionUser(username, password) {
    try {
        console.log('Login attempt for username:', username);
        
        if (!username || !password) {
            console.log('Missing username or password');
            return { success: false, error: 'Username and password are required' };
        }
        
        const user = await ProductionDatabase.getUserByUsername(username);
        if (!user) {
            console.log('User not found:', username);
            return { success: false, error: 'Invalid credentials' };
        }
        
        console.log('User found, checking password for user ID:', user.id);
        
        if (!user.password_hash) {
            console.error('User has no password hash:', user.id);
            return { success: false, error: 'User account error - no password set' };
        }
        
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            console.log('Invalid password for user:', username);
            return { success: false, error: 'Invalid credentials' };
        }
        
        if (user.status === 'left_company') {
            console.log('Login blocked - user has left company:', username);
            return { success: false, error: 'Your account is no longer active' };
        }
        
        console.log('Login successful for user:', username, 'ID:', user.id, 'Role:', user.role);
        
        // Return user data (without password hash)
        // Ensure id is an integer for consistency
        return {
            success: true,
            user: {
                id: parseInt(user.id),
                username: user.username,
                role: user.role,
                is_driver: !!(user.is_driver === true || user.is_driver === 1)
            }
        };
    } catch (error) {
        console.error('Login error:', error);
        console.error('Error stack:', error.stack);
        return { success: false, error: 'Login failed: ' + error.message };
    }
}

// Hash password
async function hashPassword(password) {
    const saltRounds = 10;
    return await bcrypt.hash(password, saltRounds);
}

// Create default admin user if no users exist
async function createDefaultAdmin() {
    try {
        const users = await ProductionDatabase.getAllUsers();
        console.log(`📊 Production users found: ${users.length}`);
        if (users.length === 0) {
            console.log('🔧 Creating default admin user...');
            const passwordHash = await hashPassword('admin123');
            const user = await ProductionDatabase.createUser('admin', passwordHash, 'admin');
            console.log('✅ Created default production admin user (username: admin, password: admin123)');
            console.log(`   User ID: ${user.id}`);
            return true;
        } else {
            console.log('ℹ️ Production users already exist, skipping default admin creation');
            return false;
        }
    } catch (error) {
        console.error('❌ Error creating default admin:', error);
        console.error('   Error details:', error.message);
        console.error('   Stack:', error.stack);
        return false;
    }
}

module.exports = {
    requireProductionAuth,
    requireAdmin,
    requireOffice,
    requireAdminOrOffice,
    requireAdminOfficeOrSupervisor,
    requireBasicsEditor,
    denySupervisor,
    restrictOfficeToCalendarBooking,
    isOfficeCalendarAllowed,
    restrictBotToBasics,
    isBotBasicsAllowed,
    requireManager, // Legacy - kept for backward compatibility
    hasInstallerRights,
    loginProductionUser,
    hashPassword,
    createDefaultAdmin
};

