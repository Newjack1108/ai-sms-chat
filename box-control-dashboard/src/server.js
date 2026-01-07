// Box Control Dashboard - Express Server
const express = require('express');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway deployments
app.set('trust proxy', 1);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'box-control-dashboard-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// EJS layout helper - set default layout variables
app.use((req, res, next) => {
    res.locals.currentPage = '';
    res.locals.title = '';
    next();
});

// Login route (handle POST)
app.post('/login', (req, res) => {
    const { requireAuth } = require('./middleware/auth');
    
    // If APP_PASSCODE is not set, allow access (dev mode)
    if (!process.env.APP_PASSCODE || process.env.APP_PASSCODE.trim() === '') {
        req.session.authenticated = true;
        return res.redirect(req.body.redirect || '/dashboard');
    }

    const { passcode, redirect } = req.body;
    
    if (passcode === process.env.APP_PASSCODE) {
        req.session.authenticated = true;
        return res.redirect(redirect || '/dashboard');
    } else {
        return res.status(401).render('login', { 
            error: 'Invalid passcode',
            redirect: redirect || '/dashboard'
        });
    }
});

// Login page (GET)
app.get('/login', (req, res) => {
    // If APP_PASSCODE is not set, redirect to dashboard (dev mode)
    if (!process.env.APP_PASSCODE || process.env.APP_PASSCODE.trim() === '') {
        return res.redirect('/dashboard');
    }
    res.render('login', {
        error: null,
        redirect: req.query.redirect || '/dashboard'
    });
});

// Routes
const indexRoutes = require('./routes/index');
const salesRoutes = require('./routes/sales');
const productionRoutes = require('./routes/production');

app.use('/', indexRoutes);
app.use('/', salesRoutes);
app.use('/', productionRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', {
        message: 'Page not found',
        error: null
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).render('error', {
        message: 'An error occurred',
        error: process.env.NODE_ENV === 'development' ? err : null
    });
});

// Initialize database and start server
async function startServer() {
    try {
        const db = require('./db');
        await db.initializeSchema();
        console.log('✅ Database initialized');
        
        app.listen(PORT, () => {
            console.log(`🚀 Box Control Dashboard running on port ${PORT}`);
            console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
            console.log(`💰 Sales: http://localhost:${PORT}/sales`);
            console.log(`🏭 Production: http://localhost:${PORT}/production`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

