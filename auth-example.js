// Example server-side authentication for production
// This is a Node.js/Express example - adapt to your preferred backend

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const session = require('express-session');

const app = express();

// Middleware
app.use(express.json());
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true in production with HTTPS
}));

// User database (in production, use a real database)
const users = [
    {
        id: 1,
        username: 'admin',
        password: '$2b$10$hashedpassword', // bcrypt hash of 'admin123'
        role: 'admin',
        email: 'admin@company.com'
    },
    {
        id: 2,
        username: 'sales',
        password: '$2b$10$hashedpassword', // bcrypt hash of 'sales123'
        role: 'sales',
        email: 'sales@company.com'
    }
];

// Login endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Find user
        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Create session
        req.session.userId = user.id;
        req.session.role = user.role;
        
        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            'your-jwt-secret',
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                email: user.email
            },
            token
        });
        
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Protected route middleware
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin privileges required' });
    }
    next();
};

// Get current user
app.get('/api/user', requireAuth, (req, res) => {
    const user = users.find(u => u.id === req.session.userId);
    res.json({
        id: user.id,
        username: user.username,
        role: user.role,
        email: user.email
    });
});

// Settings endpoint (admin only)
app.get('/api/settings', requireAuth, requireAdmin, (req, res) => {
    // Return settings from secure server-side storage
    res.json({
        twilio: {
            accountSid: process.env.TWILIO_ACCOUNT_SID,
            authToken: process.env.TWILIO_AUTH_TOKEN,
            fromNumber: process.env.TWILIO_FROM_NUMBER
        },
        openai: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo'
        }
    });
});

// Update settings endpoint (admin only)
app.post('/api/settings', requireAuth, requireAdmin, (req, res) => {
    // Update settings in secure server-side storage
    const { twilio, openai } = req.body;
    
    // Validate and save settings
    // In production, save to database or secure config
    
    res.json({ success: true });
});

// SMS sending endpoint (authenticated users)
app.post('/api/send-sms', requireAuth, async (req, res) => {
    try {
        const { to, message } = req.body;
        
        // Use server-side Twilio credentials
        const twilio = require('twilio')(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
        
        const result = await twilio.messages.create({
            body: message,
            from: process.env.TWILIO_FROM_NUMBER,
            to: to
        });
        
        res.json({ success: true, messageId: result.sid });
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to send SMS' });
    }
});

// AI response endpoint (authenticated users)
app.post('/api/ai-response', requireAuth, async (req, res) => {
    try {
        const { message, conversationHistory } = req.body;
        
        // Use server-side OpenAI credentials
        const OpenAI = require('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'You are a helpful AI assistant for SMS conversations.' },
                ...conversationHistory,
                { role: 'user', content: message }
            ]
        });
        
        res.json({ 
            success: true, 
            response: completion.choices[0].message.content 
        });
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate AI response' });
    }
});

// Environment variables needed:
// TWILIO_ACCOUNT_SID=your_twilio_account_sid
// TWILIO_AUTH_TOKEN=your_twilio_auth_token
// TWILIO_FROM_NUMBER=your_twilio_phone_number
// OPENAI_API_KEY=your_openai_api_key
// OPENAI_MODEL=gpt-3.5-turbo

app.listen(3000, () => {
    console.log('Server running on port 3000');
});

