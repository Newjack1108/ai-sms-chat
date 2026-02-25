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

// Middleware to check if user is admin or office
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

// Legacy middleware - kept for backward compatibility (maps manager to office)
function requireManager(req, res, next) {
    if (req.session && req.session.production_user && 
        (req.session.production_user.role === 'admin' || 
         req.session.production_user.role === 'office' || 
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
                role: user.role
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
    requireManager, // Legacy - kept for backward compatibility
    loginProductionUser,
    hashPassword,
    createDefaultAdmin
};

