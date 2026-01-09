// Authentication Middleware for Box Control Dashboard
// Simple passcode-based authentication with session cookies

function requireAuth(req, res, next) {
    // Skip authentication for login routes (handled separately in server.js)
    if (req.path === '/login') {
        return next();
    }

    // If APP_PASSCODE is not set, allow access (dev mode)
    if (!process.env.APP_PASSCODE || process.env.APP_PASSCODE.trim() === '') {
        return next();
    }

    // Check if user is authenticated via session
    if (req.session && req.session.authenticated) {
        return next();
    }

    // If not authenticated and trying to access API, return 401
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Show login page
    return res.render('login', { 
        error: null,
        redirect: req.originalUrl
    });
}

function isAuthenticated(req) {
    // If APP_PASSCODE is not set, always return true (dev mode)
    if (!process.env.APP_PASSCODE || process.env.APP_PASSCODE.trim() === '') {
        return true;
    }
    return req.session && req.session.authenticated === true;
}

module.exports = {
    requireAuth,
    isAuthenticated
};


