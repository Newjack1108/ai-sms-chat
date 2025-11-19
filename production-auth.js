// Production Authentication Middleware
const bcrypt = require('bcrypt');
const { ProductionDatabase } = require('./production-database');

// Middleware to check if user is authenticated (production session)
function requireProductionAuth(req, res, next) {
    if (req.session && req.session.production_authenticated && req.session.production_user) {
        return next();
    }
    
    // For API routes, return 401
    if (req.path.startsWith('/production/api/')) {
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

// Middleware to check if user is admin or manager
function requireManager(req, res, next) {
    if (req.session && req.session.production_user && 
        (req.session.production_user.role === 'admin' || req.session.production_user.role === 'manager')) {
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
        const user = await ProductionDatabase.getUserByUsername(username);
        if (!user) {
            return { success: false, error: 'Invalid credentials' };
        }
        
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return { success: false, error: 'Invalid credentials' };
        }
        
        // Return user data (without password hash)
        return {
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        };
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: 'Login failed' };
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
    requireManager,
    loginProductionUser,
    hashPassword,
    createDefaultAdmin
};

