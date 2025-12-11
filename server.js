// Lead Qualification System - Professional CRM Interface v5.6.0 with Database Persistence
// Forcing rebuild with Node 20
const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const twilio = require('twilio');
const OpenAI = require('openai');
// Import database modules conditionally
const { isPostgreSQL } = require('./database-pg');

// Database will be selected at runtime
let LeadDatabase;
let SQLiteLeadDatabase;
let PGLeadDatabase;

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// Trust proxy for Railway deployments (important for sessions)
app.set('trust proxy', 1);

// Authentication credentials (from environment variables)
// Use defaults if not set or if empty string
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME && process.env.ADMIN_USERNAME.trim()) || 'admin';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim()) || 'admin123';

console.log(`🔐 Authentication configured`);
console.log(`   Username: "${ADMIN_USERNAME}"`);
console.log(`   Password: "${ADMIN_PASSWORD ? '***' : 'empty'}"`);

// Middleware
app.use(cors());
// More lenient JSON parser for webhooks (allows empty bodies, etc.)
app.use(express.json({ 
    strict: false,
    verify: (req, res, buf, encoding) => {
        // Log raw body for webhook endpoints for debugging
        if (req.path && (req.path.includes('/webhook/') || req.path.includes('/api/leads/reactivate'))) {
            try {
                const rawBody = buf.toString(encoding || 'utf8');
                console.log(`📦 Raw request body for ${req.path}:`, rawBody);
            } catch (e) {
                console.log(`⚠️ Could not log raw body:`, e.message);
            }
        }
    }
}));
app.use(express.urlencoded({ extended: true }));

// Error handler for JSON parsing errors (must come after JSON middleware)
app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        console.error('❌ JSON parsing error:', error.message);
        console.error('   Path:', req.path);
        console.error('   Method:', req.method);
        console.error('   Content-Type:', req.headers['content-type']);
        
        // For webhook endpoints, provide helpful error messages
        if (req.path && (req.path.includes('/webhook/') || req.path.includes('/api/leads/reactivate'))) {
            return res.status(400).json({
                success: false,
                error: 'Invalid JSON in request body',
                message: 'Please ensure the webhook sends valid JSON with Content-Type: application/json',
                details: error.message
            });
        }
        
        return res.status(400).json({
            success: false,
            error: 'Invalid JSON format'
        });
    }
    next(error);
});

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to false for Railway/proxy compatibility (proxy handles HTTPS)
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax' // Helps with cross-site requests
    }
}));

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    
    // Allow public access to login page, login endpoints, webhooks, and lead creation (for external integrations)
    if (req.path === '/login' || 
        req.path === '/api/login' || 
        req.path === '/api/auth/check' ||
        req.path === '/api/logout' ||
        req.path.startsWith('/webhook/') ||
        (req.method === 'POST' && req.path === '/api/leads') ||
        (req.method === 'POST' && req.path === '/api/leads/reactivate')) {
        return next();
    }
    
    // For API routes, return 401
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required',
            requiresLogin: true
        });
    }
    
    // For HTML pages, redirect to login
    return res.redirect('/login');
}

// Route handler for /login to serve login.html (before static files)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve static assets (CSS, JS, images) and public routes without auth
app.use((req, res, next) => {
    // Allow login page, webhooks, and static assets
    if (req.path === '/login' || 
        req.path.startsWith('/webhook/') ||
        req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg)$/)) {
        return next();
    }
    
    // Allow POST /api/leads (used by external webhooks/integrations like Make.com)
    if (req.method === 'POST' && req.path === '/api/leads') {
        return next();
    }
    
    // Check authentication for index.html and API routes
    if (req.path === '/' || req.path === '/index.html') {
        return requireAuth(req, res, next);
    }
    
    if (req.path.startsWith('/api/')) {
        return requireAuth(req, res, next);
    }
    
    // Allow other static files through
    next();
});

// Serve static files
app.use(express.static('public'));

// Production system routes and authentication
const productionRoutes = require('./production-routes');
const { initializeProductionDatabase, ProductionDatabase } = require('./production-database');
const { createDefaultAdmin } = require('./production-auth');

// Production authentication middleware
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

// Production routes (login endpoint is handled inside the routes file)
app.use('/production/api', productionRoutes);

// Serve production static files (CSS, JS) without authentication
app.use('/production', express.static(path.join(__dirname, 'public', 'production')));

// Production login page (no auth required)
app.get('/production/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'production', 'login.html'));
});

// Production root - redirect to dashboard (requires auth)
app.get('/production', requireProductionAuth, (req, res) => {
    res.redirect('/production/dashboard.html');
});

// Production HTML pages (protected)
app.get('/production/*.html', requireProductionAuth, (req, res) => {
    // Redirect staff users to timesheet page (except timesheet.html itself)
    if (req.session.production_user && 
        req.session.production_user.role === 'staff' && 
        !req.path.includes('timesheet.html') && 
        !req.path.includes('login.html')) {
        return res.redirect('/production/timesheet.html');
    }
    
    const fileName = req.path.replace('/production/', '') || 'dashboard.html';
    const filePath = path.join(__dirname, 'public', 'production', fileName);
    res.sendFile(filePath);
});

// Database is now persistent - no more in-memory storage
console.log('💾 Using SQLite database for persistent storage');

// Default custom questions for lead qualification (can be updated via API)
let CUSTOM_QUESTIONS = [
    {
        question: 'What type and size of building do you require?',
        possibleAnswers: 'mobile, skids, static, stables, stable, barn, field shelter, 12x12, 12x24, 24x12, 36x12, 12ft, 24ft, 36ft'
    },
    {
        question: 'Do you need a mobile or static building?',
        possibleAnswers: 'mobile, skids, static, permanent'
    },
    {
        question: 'When are you looking to have it ready for?',
        possibleAnswers: 'asap, urgent, week, weeks, month, months, next year, soon, whenever'
    },
    {
        question: 'Finally, what postcode will the building be going to?',
        possibleAnswers: 'any postcode format, collection, pick up, pickup, ill collect, i will collect'
    }
];

const WEBHOOK_DEDUPE_WINDOW_MS = 15000; // 15 seconds dedupe window
const recentWebhookEvents = new Map();

// Helper function to validate postcode has minimum 1 letter and 1 number
// This prevents "No" (2 letters, 0 numbers) from being accepted while allowing "M1" (1 letter, 1 number)
function isValidPostcodeFormat(text) {
    if (!text) return false;
    const letters = (text.match(/[A-Z]/gi) || []).length;
    const numbers = (text.match(/\d/g) || []).length;
    return letters >= 1 && numbers >= 1;
}

const POSTCODE_PATTERNS = [
    /\b([A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2})\b/gi,
    /\b([A-Z]{2}\d\s?\d[A-Z]{2})\b/gi,
    /\b([A-Z]\d{1,2}\s?\d[A-Z]{2})\b/gi,
    /\b([A-Z]{1,2}\d[A-Z]\s?\d[A-Z]{2})\b/gi,
    /\b([A-Z]{1,}\d{1,}[A-Z]?)\b/gi  // Updated: requires at least 1 letter and 1+ numbers
];

const TIMEFRAME_PATTERNS = [
    /\b(?:asap|a\.s\.a\.p\.|urgent|urgently|immediately|quickly|soon|soonest|right away|straight away)\b/gi,
    /\b(?:next|this|within|in)\s+(?:day|week|month|year|couple of weeks|couple of months|couple of days)s?\b/gi,
    /\b(?:few|couple of|couple|several)\s+(?:days|weeks|months)\b/gi,
    /\b\d+\s*(?:day|days|week|weeks|month|months|year|years)\b/gi,
    /\b(?:today|tomorrow|tonight|over the weekend|end of the month)\b/gi
];

const DIMENSION_REGEX = /\b(?:\d{1,3}\s?(?:x|×|by)\s?\d{1,3}|\d{1,3}\s?(?:ft|foot|feet|m|metre|meter|meters)(?:\s?(?:x|by)\s?\d{1,3}\s?(?:ft|foot|feet|m|metre|meter|meters))?)\b/gi;

function stripPatterns(text, patterns) {
    if (!text) return '';
    let result = text;
    patterns.forEach(pattern => {
        result = result.replace(pattern, ' ').trim();
    });
    return result.replace(/\s{2,}/g, ' ').trim();
}

function stripPostcodes(text) {
    let result = text;
    POSTCODE_PATTERNS.forEach(pattern => {
        result = result.replace(pattern, ' ').trim();
    });
    return result.replace(/\s{2,}/g, ' ').trim();
}

function stripTrailingConnectors(text) {
    if (!text) return '';
    return text
        .replace(/\b(to|for|in|at|on|by|around|about|within|the)\s*$/i, '')
        .replace(/^\b(to|for|in|at|on|by|around|about|within|the)\b\s*/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function findNearestDimension(text, targetIndex) {
    if (!text) return null;
    const dimensionRegex = new RegExp(DIMENSION_REGEX.source, 'gi');
    let match;
    let closest = null;
    while ((match = dimensionRegex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const distance = typeof targetIndex === 'number' ? Math.abs(start - targetIndex) : 0;
        if (!closest || distance < closest.distance) {
            closest = {
                text: match[0],
                start,
                end,
                distance
            };
        }
    }
    return closest;
}

// Assistant name (can be updated via API)
let ASSISTANT_NAME = "William";

// Reminder intervals (loaded from database on startup)
let REMINDER_INTERVALS = {
    first: 5,           // 5 minutes (default)
    second: 120,        // 120 minutes = 2 hours (default)
    final: 900,         // 900 minutes = 15 hours (default)
    checkInterval: 30   // 30 minutes (default)
};

// OpenAI Assistant configuration
let openaiClient = null;
let assistantId = null;

// Initialize OpenAI client
function initializeOpenAI() {
    if (process.env.OPENAI_API_KEY) {
        openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        assistantId = process.env.OPENAI_ASSISTANT_ID;
        console.log('🤖 OpenAI client initialized');
        console.log('🔑 OpenAI API Key:', process.env.OPENAI_API_KEY ? 'Set' : 'Not set');
        console.log('🆔 Assistant ID:', assistantId ? assistantId : 'Not set');
    } else {
        console.log('⚠️ OpenAI API key not configured');
    }
}

// Load settings from database on startup
async function loadSettingsFromDatabase() {
    try {
        // Load custom questions from database
        const dbQuestions = await LeadDatabase.getCustomQuestions();
        if (dbQuestions && Array.isArray(dbQuestions) && dbQuestions.length === 4) {
            CUSTOM_QUESTIONS = dbQuestions;
            console.log('✅ Loaded custom questions from database');
        } else {
            // Save default questions to database
            await LeadDatabase.saveCustomQuestions(CUSTOM_QUESTIONS);
            console.log('✅ Saved default questions to database');
        }
        
        // Load assistant name from database
        const dbAssistantName = await LeadDatabase.getAssistantName();
        if (dbAssistantName) {
            ASSISTANT_NAME = dbAssistantName;
        } else {
            // Save default assistant name to database
            await LeadDatabase.saveAssistantName(ASSISTANT_NAME);
            console.log('✅ Saved default assistant name to database');
        }
        
        // Load reminder intervals from database
        try {
            const intervals = await LeadDatabase.getReminderIntervals();
            REMINDER_INTERVALS = intervals;
            console.log('✅ Loaded reminder intervals from database:', REMINDER_INTERVALS);
        } catch (error) {
            console.log('⚠️ Could not load reminder intervals, using defaults:', error.message);
            // Continue with defaults
        }
    } catch (error) {
        console.error('❌ Error loading settings from database:', error);
        // Continue with defaults if database fails
    }
}

// ============================================================================
// CRM WEBHOOK FUNCTIONS
// ============================================================================

// Get CRM webhook URL from database
async function getCRMWebhookURL() {
    try {
        const settingValue = await LeadDatabase.getSetting('crmWebhook');
        if (!settingValue) {
            return null;
        }
        
        // Parse the JSON value
        const webhookData = JSON.parse(settingValue);
        return webhookData.webhookUrl || null;
    } catch (error) {
        console.error('❌ Error getting CRM webhook URL:', error);
        return null;
    }
}

function normalizeLeadAnswers(lead) {
    if (!lead || lead.answers === undefined || lead.answers === null) {
        return {};
    }

    if (typeof lead.answers === 'object') {
        return lead.answers;
    }

    if (typeof lead.answers === 'string') {
        try {
            return JSON.parse(lead.answers || '{}');
        } catch (error) {
            console.error('⚠️ Failed to parse lead answers JSON:', error.message);
            return {};
        }
    }

    return {};
}

// Helper function to create a shortened version of a question
function shortenQuestion(questionText) {
    if (!questionText) return '';
    
    // Remove common question starters
    let shortened = questionText
        .replace(/^(what|when|where|who|why|how|do|does|did|are|is|will|can|could|would)\s+/i, '')
        .replace(/\?$/, '')
        .trim();
    
    // Take first 40 characters or up to first comma/question mark
    const maxLength = 40;
    if (shortened.length > maxLength) {
        const truncated = shortened.substring(0, maxLength);
        // Try to break at a word boundary
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.6) {
            shortened = truncated.substring(0, lastSpace);
        } else {
            shortened = truncated;
        }
    }
    
    return shortened || questionText.substring(0, maxLength);
}

function buildLeadAnswerPayload(lead) {
    const normalizedAnswers = normalizeLeadAnswers(lead);
    const structuredAnswers = {};
    const flatAnswers = {};
    const labeledAnswers = {};
    let answersCount = 0;

    for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
        const questionNumber = i + 1;
        const answerKey = `question_${questionNumber}`;
        const questionDef = CUSTOM_QUESTIONS[i];
        const questionText = questionDef
            ? (typeof questionDef === 'object' ? questionDef.question : questionDef)
            : `Question ${questionNumber}`;
        const possibleAnswers = questionDef && typeof questionDef === 'object' ? questionDef.possibleAnswers || '' : '';
        const answerValue = normalizedAnswers[answerKey] || '';

        if (answerValue && answerValue.length > 0) {
            answersCount++;
        }

        structuredAnswers[answerKey] = {
            questionNumber,
            question: questionText,
            answer: answerValue,
            possibleAnswers
        };

        flatAnswers[`question_${questionNumber}_text`] = questionText;
        flatAnswers[`answer_${questionNumber}`] = answerValue;
        
        // Create labeled format: "Shortened Question: Answer"
        if (answerValue && answerValue.length > 0) {
            const shortQuestion = shortenQuestion(questionText);
            labeledAnswers[answerKey] = `${shortQuestion}: ${answerValue}`;
            // Also add as a numbered key for convenience
            labeledAnswers[`q${questionNumber}_labeled`] = `${shortQuestion}: ${answerValue}`;
        } else {
            labeledAnswers[answerKey] = '';
            labeledAnswers[`q${questionNumber}_labeled`] = '';
        }
    }

    return {
        normalizedAnswers,
        structuredAnswers,
        flatAnswers,
        labeledAnswers,
        answersCount
    };
}

// Send lead event to CRM webhook (Make / external automation)
async function sendToCRMWebhook(lead, eventType = 'lead_qualified', eventDetails = {}) {
    try {
        // Get webhook URL from database
        const webhookUrl = await getCRMWebhookURL();
        
        if (!webhookUrl || webhookUrl.trim() === '') {
            console.log('⚠️ No CRM webhook configured - skipping webhook send');
            return;
        }
        
        // Only send webhooks for qualified leads to prevent blank leads in CRM
        // Exception: Silent qualifications (manual admin action) - always send
        const isQualified = Boolean(lead.qualified) || (lead.progress || 0) >= 100;
        const isSilentQualification = eventDetails.silentQualification === true;
        
        // For lead_qualified events, only send if actually qualified (unless silent qualification)
        if (eventType === 'lead_qualified' && !isQualified && !isSilentQualification) {
            console.log(`⏩ Skipping webhook - lead ${lead.id} is not qualified yet (progress: ${lead.progress || 0}%, qualified: ${lead.qualified})`);
            return;
        }
        
        // For lead_returning_customer events, only send if lead is qualified
        // This prevents blank leads from being created in CRM
        if (eventType === 'lead_returning_customer' && !isQualified) {
            console.log(`⏩ Skipping lead_returning_customer webhook - lead ${lead.id} is not qualified yet (progress: ${lead.progress || 0}%, qualified: ${lead.qualified})`);
            return;
        }
        
        // For any other event type, if lead is not qualified and it's not a silent qualification, skip
        // This prevents blank leads from being created in CRM during lead creation
        if (!isQualified && !isSilentQualification) {
            console.log(`⏩ Skipping webhook - lead ${lead.id} is not qualified and event type '${eventType}' requires qualification`);
            return;
        }
        
        if (isSilentQualification) {
            console.log(`🔇 Silent qualification - sending webhook even if lead data is incomplete`);
        }
        
        // Dedupe repeated events for the same lead + event signature
        const qualificationMethod = eventDetails && eventDetails.qualificationMethod ? eventDetails.qualificationMethod : 'none';
        const eventHash = eventDetails && eventDetails.meta && eventDetails.meta.eventId
            ? `${lead.id}:${eventType}:${eventDetails.meta.eventId}`
            : `${lead.id}:${eventType}:${qualificationMethod}`;
        const now = Date.now();
        const lastSent = recentWebhookEvents.get(eventHash);
        if (lastSent && (now - lastSent) < WEBHOOK_DEDUPE_WINDOW_MS) {
            console.log(`⏩ Skipping duplicate webhook event (${eventHash}) sent ${now - lastSent}ms ago`);
            return;
        }
        recentWebhookEvents.set(eventHash, now);
        for (const [key, timestamp] of recentWebhookEvents.entries()) {
            if (now - timestamp > WEBHOOK_DEDUPE_WINDOW_MS) {
                recentWebhookEvents.delete(key);
            }
        }
        
        console.log(`📤 Sending "${eventType}" event to CRM webhook...`);
        
        // Get source display name
        let sourceDisplay = lead.source || 'Unknown';
        try {
            const sourceMapping = await LeadDatabase.getSourceByTechnicalId(lead.source);
            if (sourceMapping) {
                sourceDisplay = sourceMapping.display_name;
            }
        } catch (error) {
            console.log('⚠️ Could not get source mapping:', error.message);
        }
        
        const eventTimestamp = new Date().toISOString();
        
        const {
            normalizedAnswers,
            structuredAnswers,
            flatAnswers,
            labeledAnswers,
            answersCount
        } = buildLeadAnswerPayload(lead);
        
        // Build filtered labeled answers for leadPayload
        const filteredLabeledAnswersForPayload = {};
        const labeledAnswersArray = [];
        Object.entries(labeledAnswers).forEach(([key, value]) => {
            if (value && typeof value === 'string' && value.trim().length > 0) {
                filteredLabeledAnswersForPayload[key] = value;
                // Collect q1_labeled, q2_labeled, etc. for the combined field
                if (key.startsWith('q') && key.endsWith('_labeled')) {
                    labeledAnswersArray.push(value);
                }
            }
        });
        
        // Create a combined field with all labeled answers on separate lines
        const labeledAnswersCombined = labeledAnswersArray.join('\n');
        
        const leadPayload = {
            id: lead.id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            source: lead.source,
            source_display: sourceDisplay,
            status: lead.status || 'unknown',
            progress: lead.progress || 0,
            qualified: Boolean(lead.qualified),
            qualifiedDate: lead.qualifiedDate || null,
            answers: normalizedAnswers,
            answers_structured: structuredAnswers,
            answers_flat: flatAnswers,
            answers_labeled: filteredLabeledAnswersForPayload,
            answers_labeled_combined: labeledAnswersCombined,
            returning_customer: Boolean(lead.returning_customer),
            times_qualified: lead.times_qualified || 0
        };

        // Normalize qualified flag for automation consumers
        if (eventDetails.silentQualification === true) {
            leadPayload.qualified = false;
        } else if ((leadPayload.progress || 0) >= 100) {
            leadPayload.qualified = true;
        }
        
        const metadata = {
            returning_customer: leadPayload.returning_customer,
            times_qualified: leadPayload.times_qualified,
            first_qualified_date: lead.first_qualified_date || null,
            last_qualified_date: lead.last_qualified_date || null,
            answers_count: answersCount,
            answers_complete: answersCount >= CUSTOM_QUESTIONS.length,
            questions_total: CUSTOM_QUESTIONS.length
        };
        
        if (eventDetails.triggeredBy) {
            metadata.triggered_by = eventDetails.triggeredBy;
        }
        
        if (eventDetails.qualificationMethod) {
            metadata.qualification_method = eventDetails.qualificationMethod;
        }
        if (eventDetails.silentQualification !== undefined) {
            metadata.silent_qualification = Boolean(eventDetails.silentQualification);
        }
        if (eventDetails.meta && typeof eventDetails.meta === 'object') {
            Object.assign(metadata, eventDetails.meta);
        }
        
        // Prepare webhook data
        const webhookData = {
            ...leadPayload, // Maintain backward compatibility for legacy consumers
            event_type: eventType,
            event_timestamp: eventTimestamp,
            lead: leadPayload,
            customQuestions: CUSTOM_QUESTIONS,
            metadata,
            answers_flat: flatAnswers,
            answers_structured: structuredAnswers,
            answers_labeled: leadPayload.answers_labeled
        };

        // Expose convenience fields (answer_1, answer_2, etc.) for external tools
        Object.entries(flatAnswers).forEach(([key, value]) => {
            webhookData[key] = value;
        });
        
        // Expose labeled answers (question: answer format) for convenience
        // Use the same filtered labeled answers from leadPayload
        Object.entries(leadPayload.answers_labeled).forEach(([key, value]) => {
            webhookData[key] = value; // Also expose as individual fields
        });
        
        // Ensure answers_labeled is in webhookData (it should already be from leadPayload spread, but be explicit)
        webhookData.answers_labeled = leadPayload.answers_labeled;
        
        // Debug: Log labeled answers to verify they're being created
        console.log('📋 Labeled answers (raw):', JSON.stringify(labeledAnswers, null, 2));
        console.log('📋 Filtered labeled answers:', JSON.stringify(leadPayload.answers_labeled, null, 2));
        console.log('📦 Webhook payload (answers_labeled check):', webhookData.answers_labeled ? 'EXISTS' : 'MISSING');
        console.log('📦 Webhook payload:', JSON.stringify(webhookData, null, 2));
        
        // Send webhook
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(webhookData)
        });
        
        if (response.ok) {
            console.log('✅ Successfully sent qualified lead to CRM webhook');
            console.log(`   Lead: ${lead.name} (${lead.phone})`);
            console.log(`   Webhook URL: ${webhookUrl}`);
        } else {
            console.error('❌ CRM webhook failed:', response.status, response.statusText);
            const errorText = await response.text().catch(() => 'No error details');
            console.error('   Error details:', errorText);
            recentWebhookEvents.delete(eventHash);
        }
        
    } catch (error) {
        console.error('❌ Error sending to CRM webhook:', error.message);
        console.error('   Stack:', error.stack);
        recentWebhookEvents.delete(eventHash);
        // Don't throw - webhook failure shouldn't break the app
    }
}

// Initialize on startup
initializeOpenAI();

// ========================================
// API ENDPOINTS
// ========================================

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

// Login endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    console.log(`🔐 Login attempt received`);
    console.log(`   Username received: "${username}"`);
    console.log(`   Password received: "${password ? '***' : 'empty'}"`);
    console.log(`   Expected username: "${ADMIN_USERNAME}"`);
    console.log(`   Expected password: "${ADMIN_PASSWORD ? '***' : 'empty'}"`);
    console.log(`   Username match: ${username === ADMIN_USERNAME}`);
    console.log(`   Password match: ${password === ADMIN_PASSWORD}`);
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.authenticated = true;
        req.session.username = username;
        console.log(`✅ User logged in: ${username}`);
        console.log(`   Session authenticated: ${req.session.authenticated}`);
        res.json({
            success: true,
            message: 'Login successful'
        });
    } else {
        console.log(`❌ Failed login attempt for username: ${username}`);
        res.status(401).json({
            success: false,
            error: 'Invalid username or password'
        });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({
                success: false,
                error: 'Logout failed'
            });
        }
        console.log('✅ User logged out');
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    });
});

// Check authentication status
app.get('/api/auth/check', (req, res) => {
    res.json({
        authenticated: req.session && req.session.authenticated === true,
        username: req.session && req.session.username ? req.session.username : null
    });
});

// Get all leads
app.get('/api/leads', async (req, res) => {
    try {
        const leads = await LeadDatabase.getAllLeads();
        
        // Enrich leads with source display names
        const leadSources = await LeadDatabase.getLeadSources();
        const sourceMap = {};
        leadSources.forEach(src => {
            sourceMap[src.technical_id] = src.display_name;
        });
        
        const enrichedLeads = leads.map(lead => ({
            ...lead,
            source_display: sourceMap[lead.source] || lead.source || 'Unknown Source'
        }));
        
        res.json(enrichedLeads);
    } catch (error) {
        console.error('Error fetching leads:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get messages for a specific lead
app.get('/api/leads/:leadId/messages', async (req, res) => {
    try {
        const { leadId } = req.params;
        const leadMessages = await LeadDatabase.getMessagesByLeadId(parseInt(leadId));
        res.json(leadMessages);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Send message to lead
app.post('/api/leads/send-message', async (req, res) => {
    try {
        const { leadId, message } = req.body;
        
        if (!leadId || !message) {
            return res.status(400).json({
                success: false,
                error: 'Lead ID and message are required'
            });
        }
        
        const lead = await LeadDatabase.getLeadById(parseInt(leadId));
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Store admin/assistant message in database
        await LeadDatabase.createMessage(parseInt(leadId), 'assistant', message);
        
        // Send SMS to customer
        await sendSMS(lead.phone, message);
        
        // Generate AI response
        const aiResponse = await generateAIResponseWithAssistant(lead, message);
        
        if (aiResponse) {
            // Store AI response in database
            await LeadDatabase.createMessage(parseInt(leadId), 'assistant', aiResponse);
            
            // Send AI response as SMS
            await sendSMS(lead.phone, aiResponse);
        }
        
        res.json({
            success: true,
            aiResponse: aiResponse
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Qualify lead
app.post('/api/leads/:leadId/qualify', async (req, res) => {
    try {
        const { leadId} = req.params;
        
        const lead = await LeadDatabase.getLeadById(parseInt(leadId));
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Mark as qualified in database
        await LeadDatabase.updateLead(parseInt(leadId), {
            ...lead,
            qualified: true,
            status: 'qualified',
            progress: 100,
            qualifiedDate: new Date().toISOString()
        });
        
        // Send qualification message
        const qualificationMessage = `🎉 Excellent! I have all the information I need to help you.

Based on your answers, I'll have our team prepare a customized proposal for your equine stable project. Someone will contact you within 24 hours to discuss next steps.

Thank you for your time! 🐴✨`;

        await sendSMS(lead.phone, qualificationMessage);
        
        // Store qualification message
        const qualMessage = {
            id: messageIdCounter++,
            leadId: leadId,
            sender: 'assistant',
            content: qualificationMessage,
            timestamp: new Date().toISOString()
        };
        messages.push(qualMessage);
        
        // Get updated lead for webhook
        const updatedLead = await LeadDatabase.getLeadById(parseInt(leadId));
        
        // 🔥 SEND TO CRM WEBHOOK
        try {
            await sendToCRMWebhook(updatedLead, 'lead_qualified', {
                qualificationMethod: 'manual',
                triggeredBy: 'admin_portal'
            });
        } catch (error) {
            console.error('⚠️ Failed to send webhook (non-critical):', error.message);
        }

        res.json({
            success: true,
            message: 'Lead qualified successfully and sent to CRM'
        });
    } catch (error) {
        console.error('Error qualifying lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Silent qualify lead (no message sent)
app.post('/api/leads/:leadId/silent-qualify', async (req, res) => {
    try {
        const { leadId} = req.params;
        
        const lead = await LeadDatabase.getLeadById(parseInt(leadId));
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Mark as qualified in database (no message sent)
        await LeadDatabase.updateLead(parseInt(leadId), {
            ...lead,
            qualified: true,
            status: 'qualified',
            progress: 100,
            qualifiedDate: new Date().toISOString()
        });
        
        console.log(`🔇 Silent qualification: ${lead.name} (${lead.phone}) - no message sent`);
        
        // Get updated lead for webhook
        const updatedLead = await LeadDatabase.getLeadById(parseInt(leadId));
        
        // 🔥 SEND TO CRM WEBHOOK (even if not all questions answered)
        try {
            await sendToCRMWebhook(updatedLead, 'lead_qualified', {
                qualificationMethod: 'silent',
                silentQualification: true,
                triggeredBy: 'admin_portal'
            });
        } catch (error) {
            console.error('⚠️ Failed to send webhook (non-critical):', error.message);
        }

        res.json({
            success: true,
            message: 'Lead silently qualified successfully and sent to CRM'
        });
    } catch (error) {
        console.error('Error silently qualifying lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// Update all settings (custom questions, assistant name, webhook, etc.)
app.post('/api/settings', async (req, res) => {
    try {
        const { customQuestions, assistantName, crmWebhook, crmKey } = req.body;
        
        console.log('📝 Updating settings...');
        console.log('   Custom Questions:', customQuestions);
        console.log('   Assistant Name:', assistantName);
        console.log('   CRM Webhook:', crmWebhook ? '***configured***' : 'not set');
        
        // Update custom questions if provided
        if (customQuestions && Array.isArray(customQuestions)) {
            if (customQuestions.length !== 4) {
                return res.status(400).json({
                    success: false,
                    error: 'Exactly 4 questions are required'
                });
            }
            
            // Validate questions
            const validQuestions = customQuestions.filter(q => {
                if (typeof q === 'object') {
                    return q.question && q.question.trim().length > 0;
                } else if (typeof q === 'string') {
                    return q.trim().length > 0;
                }
                return false;
            });
            
            if (validQuestions.length !== 4) {
                return res.status(400).json({
                    success: false,
                    error: 'All 4 questions must be filled out'
                });
            }
            
            CUSTOM_QUESTIONS = customQuestions;
            // Save to database
            LeadDatabase.saveCustomQuestions(customQuestions);
            console.log('✅ Custom questions updated with possible answers');
        }
        
        // Update assistant name if provided
        if (assistantName && assistantName.trim().length > 0) {
            ASSISTANT_NAME = assistantName.trim();
            // Save to database
            LeadDatabase.saveAssistantName(ASSISTANT_NAME);
            console.log('✅ Assistant name updated to:', ASSISTANT_NAME);
        }
        
        // Update CRM webhook if provided
        if (crmWebhook !== undefined) {
            const webhookData = {
                webhookUrl: crmWebhook || '',
                apiKey: crmKey || ''
            };
            await LeadDatabase.saveSetting('crmWebhook', JSON.stringify(webhookData));
            console.log('✅ CRM webhook updated:', crmWebhook ? 'configured' : 'cleared');
        }
        
        // Update reminder intervals if provided
        const { reminderFirst, reminderSecond, reminderFinal, reminderCheckInterval } = req.body;
        if (reminderFirst !== undefined || reminderSecond !== undefined || reminderFinal !== undefined || reminderCheckInterval !== undefined) {
            const currentIntervals = await LeadDatabase.getReminderIntervals();
            const newIntervals = {
                first: reminderFirst !== undefined ? parseInt(reminderFirst) : currentIntervals.first,
                second: reminderSecond !== undefined ? parseInt(reminderSecond) : currentIntervals.second,
                final: reminderFinal !== undefined ? parseInt(reminderFinal) : currentIntervals.final,
                checkInterval: reminderCheckInterval !== undefined ? parseInt(reminderCheckInterval) : currentIntervals.checkInterval
            };
            
            await LeadDatabase.saveReminderIntervals(
                newIntervals.first,
                newIntervals.second,
                newIntervals.final,
                newIntervals.checkInterval
            );
            
            // Update runtime variable
            REMINDER_INTERVALS.first = newIntervals.first;
            REMINDER_INTERVALS.second = newIntervals.second;
            REMINDER_INTERVALS.final = newIntervals.final;
            REMINDER_INTERVALS.checkInterval = newIntervals.checkInterval;
            
            console.log('✅ Reminder intervals updated:', newIntervals);
        }
        
        res.json({
            success: true,
            message: 'Settings updated successfully (saved to database)',
            customQuestions: CUSTOM_QUESTIONS,
            assistantName: ASSISTANT_NAME,
            reminderIntervals: REMINDER_INTERVALS
        });
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current settings
app.get('/api/settings', async (req, res) => {
    try {
        // Get CRM webhook settings from database
        let crmWebhookUrl = '';
        let crmApiKey = '';
        try {
            const webhookSetting = await LeadDatabase.getSetting('crmWebhook');
            if (webhookSetting) {
                const webhookData = JSON.parse(webhookSetting);
                crmWebhookUrl = webhookData.webhookUrl || '';
                crmApiKey = webhookData.apiKey || '';
            }
        } catch (error) {
            console.log('⚠️ Could not load CRM webhook settings:', error.message);
        }
        
        // Get reminder intervals from database
        let reminderIntervals = REMINDER_INTERVALS;
        try {
            reminderIntervals = await LeadDatabase.getReminderIntervals();
        } catch (error) {
            console.log('⚠️ Could not load reminder intervals, using runtime values:', error.message);
        }
        
        res.json({
            success: true,
            customQuestions: CUSTOM_QUESTIONS,
            assistantName: ASSISTANT_NAME,
            crmWebhook: crmWebhookUrl,
            crmKey: crmApiKey,
            reminderIntervals: reminderIntervals
        });
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Legacy endpoints for backward compatibility
app.post('/api/settings/questions', (req, res) => {
    const { questions } = req.body;
    req.body.customQuestions = questions;
    return app._router.handle(req, res);
});

app.get('/api/settings/questions', (req, res) => {
    res.json({
        success: true,
        questions: CUSTOM_QUESTIONS
    });
});

// ============================================================================
// LEAD SOURCE MANAGEMENT API ENDPOINTS
// ============================================================================

// Get all lead sources
app.get('/api/settings/lead-sources', async (req, res) => {
    try {
        const sources = await LeadDatabase.getLeadSources();
        res.json({
            success: true,
            sources: sources
        });
    } catch (error) {
        console.error('Error fetching lead sources:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create new lead source
app.post('/api/settings/lead-sources', async (req, res) => {
    try {
        const { technicalId, displayName } = req.body;
        
        if (!technicalId || !displayName) {
            return res.status(400).json({
                success: false,
                error: 'Technical ID and Display Name are required'
            });
        }
        
        // Validate technical ID format (alphanumeric and underscore only)
        if (!/^[a-z0-9_]+$/i.test(technicalId)) {
            return res.status(400).json({
                success: false,
                error: 'Technical ID must contain only letters, numbers, and underscores'
            });
        }
        
        const newSource = await LeadDatabase.createLeadSource(technicalId, displayName);
        res.json({
            success: true,
            source: newSource,
            message: 'Lead source created successfully'
        });
    } catch (error) {
        console.error('Error creating lead source:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update lead source
app.put('/api/settings/lead-sources/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { displayName, active } = req.body;
        
        if (!displayName) {
            return res.status(400).json({
                success: false,
                error: 'Display Name is required'
            });
        }
        
        const updated = await LeadDatabase.updateLeadSource(
            parseInt(id), 
            displayName, 
            active !== undefined ? active : true
        );
        
        if (updated) {
            res.json({
                success: true,
                message: 'Lead source updated successfully'
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Lead source not found'
            });
        }
    } catch (error) {
        console.error('Error updating lead source:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete lead source
app.delete('/api/settings/lead-sources/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await LeadDatabase.deleteLeadSource(parseInt(id));
        res.json({
            success: true,
            message: 'Lead source deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting lead source:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
});

// Test endpoint to manually check and trigger reminders
app.get('/api/test-reminders', async (req, res) => {
    try {
        const now = new Date();
        const leads = await LeadDatabase.getAllLeads();
        
        const divisor = 1000 * 60; // ms to minutes
        
        const results = [];
        
        for (const lead of leads) {
            const leadInfo = {
                id: lead.id,
                name: lead.name,
                phone: lead.phone,
                qualified: lead.qualified,
                ai_paused: lead.ai_paused,
                progress: lead.progress,
                last_customer_message_time: lead.last_customer_message_time,
                createdAt: lead.createdAt,
                reminder_1hr_sent: lead.reminder_1hr_sent,
                reminder_24hr_sent: lead.reminder_24hr_sent,
                reminder_48hr_sent: lead.reminder_48hr_sent,
                status: 'Not eligible'
            };
            
            // Check eligibility
            if (lead.qualified || lead.ai_paused || lead.status === 'closed') {
                leadInfo.status = 'Skipped (qualified, paused, or closed)';
                results.push(leadInfo);
                continue;
            }
            
            // Skip if Q1 hasn't been answered yet
            if (!lead.answers || !lead.answers.question_1) {
                leadInfo.status = 'Skipped (Q1 not answered yet)';
                results.push(leadInfo);
                continue;
            }
            
            if (!lead.last_customer_message_time) {
                leadInfo.status = 'Skipped (no last message time)';
                results.push(leadInfo);
                continue;
            }
            
            // Calculate time since last message
            const lastMessageTime = new Date(lead.last_customer_message_time);
            const timeSinceLastMessage = (now - lastMessageTime) / divisor;
            
            leadInfo.timeSinceLastMessage = `${timeSinceLastMessage.toFixed(1)} minutes`;
            leadInfo.status = 'Eligible for reminders';
            
            // Check which reminders should be sent
            if (timeSinceLastMessage >= REMINDER_INTERVALS.first && !lead.reminder_1hr_sent) {
                leadInfo.nextAction = `Send first reminder (threshold: ${REMINDER_INTERVALS.first} minutes)`;
            } else if (timeSinceLastMessage >= REMINDER_INTERVALS.second && !lead.reminder_24hr_sent) {
                leadInfo.nextAction = `Send second reminder (threshold: ${REMINDER_INTERVALS.second} minutes)`;
            } else if (timeSinceLastMessage >= REMINDER_INTERVALS.final && !lead.reminder_48hr_sent) {
                leadInfo.nextAction = `Send final reminder (threshold: ${REMINDER_INTERVALS.final} minutes)`;
            } else {
                leadInfo.nextAction = `Waiting (next check at ${REMINDER_INTERVALS.first} minutes)`;
            }
            
            results.push(leadInfo);
        }
        
        res.json({
            success: true,
            intervals: REMINDER_INTERVALS,
            timeUnit: 'minutes',
            totalLeads: leads.length,
            leads: results,
            message: 'Use /api/trigger-reminders to actually send reminders for testing'
        });
    } catch (error) {
        console.error('Error testing reminders:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test endpoint to actually trigger reminders manually
app.post('/api/trigger-reminders', async (req, res) => {
    try {
        console.log('🧪 MANUAL REMINDER CHECK TRIGGERED');
        await checkAndSendReminders();
        res.json({
            success: true,
            message: 'Reminder check completed. Check server logs for details.'
        });
    } catch (error) {
        console.error('Error triggering reminders:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete all leads (for testing - BE CAREFUL!)
app.post('/api/delete-all-leads', async (req, res) => {
    try {
        if (isPostgreSQL) {
            // Use nuclear delete for PostgreSQL (works reliably)
            const { pool } = require('./database-pg');
            
            console.log('🗑️ Using nuclear delete for PostgreSQL...');
            
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                console.log('🗑️ Transaction started');
                
                const messagesResult = await client.query('DELETE FROM messages');
                console.log(`🗑️ Deleted ${messagesResult.rowCount} messages`);
                
                const leadsResult = await client.query('DELETE FROM leads');
                console.log(`🗑️ Deleted ${leadsResult.rowCount} leads`);
                
                await client.query('COMMIT');
                console.log('✅ Transaction committed');
                
                res.json({
                    success: true,
                    message: `Deleted ${leadsResult.rowCount} leads and ${messagesResult.rowCount} messages`,
                    deletedCount: leadsResult.rowCount,
                    messagesDeleted: messagesResult.rowCount
                });
            } catch (error) {
                await client.query('ROLLBACK');
                console.error('❌ Transaction rolled back:', error);
                throw error;
            } finally {
                client.release();
            }
        } else {
            // SQLite - use regular method
            const leads = await LeadDatabase.getAllLeads();
            console.log(`📊 Found ${leads.length} leads in SQLite`);
            
            let deletedCount = 0;
            let messagesDeleted = 0;
            
            for (const lead of leads) {
                try {
                    const messages = await LeadDatabase.getMessagesByLeadId(lead.id);
                    messagesDeleted += messages.length;
                    
                    const result = await LeadDatabase.deleteLead(lead.id);
                    deletedCount++;
                    console.log(`🗑️ Deleted lead: ${lead.name} (ID: ${lead.id})`);
                } catch (error) {
                    console.error(`❌ Failed to delete lead ${lead.id}:`, error.message);
                }
            }
            
            console.log(`✅ Cleanup complete: ${deletedCount} leads and ${messagesDeleted} messages deleted`);
            
            res.json({
                success: true,
                message: `Deleted ${deletedCount} leads and ${messagesDeleted} messages`,
                deletedCount: deletedCount,
                messagesDeleted: messagesDeleted
            });
        }
    } catch (error) {
        console.error('Error deleting all leads:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🧪 DEBUG ENDPOINT: Check what's in the database
app.get('/api/debug/database-info', async (req, res) => {
    try {
        const leads = await LeadDatabase.getAllLeads();
        const databaseType = isPostgreSQL ? 'PostgreSQL' : 'SQLite';
        
        // Get total message count
        let totalMessages = 0;
        for (const lead of leads) {
            const messages = await LeadDatabase.getMessagesByLeadId(lead.id);
            totalMessages += messages.length;
        }
        
        res.json({
            databaseType,
            totalLeads: leads.length,
            totalMessages,
            leads: leads.map(l => ({
                id: l.id,
                phone: l.phone,
                name: l.name,
                status: l.status,
                progress: l.progress,
                qualified: l.qualified,
                createdAt: l.createdAt
            }))
        });
    } catch (error) {
        console.error('Error getting database info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🧪 DEBUG ENDPOINT: Direct PostgreSQL message count
app.get('/api/debug/message-count', async (req, res) => {
    if (!isPostgreSQL) {
        return res.json({ error: 'Not using PostgreSQL' });
    }
    
    try {
        const { pool } = require('./database-pg');
        const result = await pool.query('SELECT COUNT(*) as count FROM messages');
        const leadResult = await pool.query('SELECT COUNT(*) as count FROM leads');
        
        res.json({
            database: 'PostgreSQL',
            totalMessages: parseInt(result.rows[0].count),
            totalLeads: parseInt(leadResult.rows[0].count),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error querying PostgreSQL:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🧪 NUCLEAR OPTION: Delete everything directly with raw SQL
app.post('/api/debug/nuclear-delete', async (req, res) => {
    if (!isPostgreSQL) {
        return res.json({ error: 'Not using PostgreSQL' });
    }
    
    try {
        const { pool } = require('./database-pg');
        
        console.log('☢️ NUCLEAR DELETE: Starting direct SQL delete...');
        
        // Delete with explicit client and transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            console.log('☢️ Transaction started');
            
            const messagesResult = await client.query('DELETE FROM messages');
            console.log(`☢️ Deleted ${messagesResult.rowCount} messages`);
            
            const leadsResult = await client.query('DELETE FROM leads');
            console.log(`☢️ Deleted ${leadsResult.rowCount} leads`);
            
            await client.query('COMMIT');
            console.log('☢️ Transaction committed');
            
            res.json({
                success: true,
                messagesDeleted: messagesResult.rowCount,
                leadsDeleted: leadsResult.rowCount,
                message: 'Nuclear delete complete'
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('☢️ Transaction rolled back:', error);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error in nuclear delete:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create new lead
app.post('/api/leads', async (req, res) => {
    try {
        console.log('📝 Creating new lead...');
        console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

        const { name, email, phone, source, initialMessage } = req.body;

        if (!name || !email || !phone) {
            console.log('❌ Missing required fields');
            return res.status(400).json({
                success: false,
                error: 'Name, email, and phone are required'
            });
        }

        const normalizedPhone = normalizePhoneNumber(phone);
        
        // Check if lead already exists in database (includes restoring archived leads)
        let existingLead = await LeadDatabase.checkExistingCustomer(normalizedPhone);
        if (existingLead) {
            console.log(`👤 Found existing lead: ${existingLead.name} (ID: ${existingLead.id})`);
            console.log(`   Current status: ${existingLead.status}, Qualified: ${existingLead.qualified}`);
            
            // If they're already qualified, this is a NEW inquiry - reset them
            if (existingLead.qualified || existingLead.status === 'qualified') {
                console.log(`🔄 EXISTING QUALIFIED CUSTOMER - Manual add triggering NEW inquiry (auto-reset)`);
                console.log(`   📊 Previous qualification: ${existingLead.qualifiedDate}`);
                console.log(`   📈 Times previously qualified: ${existingLead.times_qualified || 0}`);
                
                // Save previous qualification data
                const previousQualifiedDate = existingLead.qualifiedDate;
                
                // Reset for new qualification
                await LeadDatabase.updateLead(existingLead.id, {
                    name: name || existingLead.name,
                    email: email || existingLead.email,
                    source: source || existingLead.source,
                    status: 'new',              // Reset to new
                    progress: 0,                 // Reset progress
                    qualified: false,            // Unqualify
                    ai_paused: 0,                // Unpause AI
                    post_qualification_response_sent: false,  // Reset flag
                    answers: {},                 // Clear answers for fresh start
                    qualifiedDate: null,         // Clear current qualification
                    returning_customer: true,    // Flag as returning
                    times_qualified: (existingLead.times_qualified || 0) + 1,  // Increment
                    first_qualified_date: existingLead.first_qualified_date || previousQualifiedDate,
                    last_qualified_date: previousQualifiedDate
                });
                
                console.log(`✅ Returning customer reset for NEW manual inquiry`);
                
                // Reset reminder tracking for fresh start
                try {
                    await LeadDatabase.updateLastCustomerMessageTime(existingLead.id, new Date().toISOString());
                    await LeadDatabase.resetReminderFlags(existingLead.id);
                    console.log(`🔄 Reset reminder tracking for returning customer`);
                } catch (error) {
                    console.error(`⚠️ Failed to reset reminder tracking (non-critical):`, error.message);
                }
                
                // Get fresh lead data
                existingLead = await LeadDatabase.getLeadById(existingLead.id);
                
                // Notify automation about returning customer event
                try {
                    await sendToCRMWebhook(existingLead, 'lead_returning_customer', {
                        triggeredBy: 'admin_portal',
                        meta: {
                            previous_qualified_date: previousQualifiedDate
                        }
                    });
                } catch (error) {
                    console.error('⚠️ Failed to send returning customer webhook (non-critical):', error.message);
                }
                
                // Process initialMessage if provided (e.g., from Facebook Lead Ads)
                if (initialMessage && initialMessage.trim().length > 0) {
                    console.log(`📝 Processing initial message for returning customer: "${initialMessage}"`);
                    
                    try {
                        // Initialize answers object
                        existingLead.answers = existingLead.answers || {};
                        let newAnswersFound = 0;
                        
                        // AGGRESSIVELY extract answers for ALL unanswered questions from the FIRST message
                        console.log(`🔍 AGGRESSIVE EXTRACTION: Scanning first message for ALL possible answers...`);
                        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                            const questionKey = `question_${i + 1}`;
                            
                            // Skip if already answered
                            if (existingLead.answers[questionKey]) {
                                console.log(`   ⏭️ Q${i + 1} already answered, skipping`);
                                continue;
                            }
                            
                            const question = CUSTOM_QUESTIONS[i];
                            const possibleAnswers = typeof question === 'object' ? question.possibleAnswers : '';
                            
                            if (!possibleAnswers) {
                                console.log(`   ⚠️ Q${i + 1} has no possible answers defined, skipping`);
                                continue;
                            }
                            
                            // Extract answer for this question - be more lenient for first message
                            const extractedAnswer = extractAnswerForQuestion(initialMessage, possibleAnswers, i + 1);
                            
                            if (extractedAnswer) {
                                // Normalize answer to lowercase for consistent storage and comparison
                                const normalizedAnswer = typeof extractedAnswer === 'string' ? extractedAnswer.toLowerCase().trim() : extractedAnswer;
                                existingLead.answers[questionKey] = normalizedAnswer;
                                newAnswersFound++;
                                console.log(`   ✅ Extracted answer for Q${i + 1} from first message: "${normalizedAnswer}"`);
                            } else {
                                console.log(`   ❓ Could not extract answer for Q${i + 1} from first message`);
                            }
                        }
                        
                        // Update progress if any new answers were found
                        if (newAnswersFound > 0) {
                            // Count only actual answers, not tracking fields
                            const newAnsweredCount = Object.keys(existingLead.answers).filter(k => !k.startsWith('_')).length;
                            existingLead.progress = Math.round((newAnsweredCount / 4) * 100);
                            existingLead.status = existingLead.progress === 100 ? 'qualified' : 'active';
                            
                            // Save extracted answers to database
                            await LeadDatabase.updateLead(existingLead.id, {
                                name: existingLead.name,
                                email: existingLead.email,
                                status: existingLead.status,
                                progress: existingLead.progress,
                                qualified: existingLead.progress === 100,
                                ai_paused: existingLead.ai_paused,
                                post_qualification_response_sent: false,
                                answers: existingLead.answers,
                                qualifiedDate: existingLead.progress === 100 ? new Date().toISOString() : null,
                                returning_customer: existingLead.returning_customer || false,
                                times_qualified: existingLead.times_qualified || 0,
                                first_qualified_date: existingLead.first_qualified_date,
                                last_qualified_date: existingLead.last_qualified_date
                            });
                            
                            // Update last customer message time for reminder tracking
                            await LeadDatabase.updateLastCustomerMessageTime(existingLead.id, new Date().toISOString());
                            
                            console.log(`✅ Processed initial message: ${newAnswersFound} answers extracted, progress: ${existingLead.progress}%`);
                            
                            // If fully qualified, send webhook
                            if (existingLead.progress === 100) {
                                console.log(`🎉 Returning customer fully qualified from initial message!`);
                                const qualifiedLead = await LeadDatabase.getLeadById(existingLead.id);
                                try {
                                    await sendToCRMWebhook(qualifiedLead, 'lead_qualified', {
                                        qualificationMethod: 'auto_initial_message',
                                        triggeredBy: 'admin_portal',
                                        meta: {
                                            initial_message_processed: true
                                        }
                                    });
                                } catch (error) {
                                    console.error('⚠️ Failed to send webhook (non-critical):', error.message);
                                }
                            }
                        }
                        
                        // ALWAYS reload lead after processing initialMessage to ensure fresh data for sendAIIntroduction
                        existingLead = await LeadDatabase.getLeadById(existingLead.id);
                        console.log(`🔄 Reloaded lead after initialMessage processing. Progress: ${existingLead.progress}%, Answers: ${Object.keys(existingLead.answers || {}).length}`);
                    } catch (error) {
                        console.error('⚠️ Error processing initial message (non-critical):', error.message);
                    }
                }
                
                // Send AI introduction or qualification message for the NEW inquiry
                try {
                    // If lead is already fully qualified from initial message, send qualification message instead
                    if (existingLead.progress === 100 && existingLead.qualified) {
                        console.log(`🎉 Returning customer already qualified from initial message - sending qualification message instead of intro`);
                        const qualificationMessage = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
                        
                        await sendSMS(existingLead.phone, qualificationMessage);
                        await LeadDatabase.createMessage(existingLead.id, 'assistant', qualificationMessage);
                    } else {
                        // Send normal introduction asking first question
                        await sendAIIntroduction(existingLead, true); // true = returning customer
                    }
                } catch (introError) {
                    console.error('Error sending AI introduction/qualification:', introError);
                }
                
                return res.json(existingLead);
            }
            
            // Lead exists but not qualified yet - just return it
            console.log(`✅ Using existing/restored unqualified lead: ${existingLead.name} (ID: ${existingLead.id})`);
            return res.json(existingLead);
        }
        
        // Create new lead in database
        let newLead = await LeadDatabase.createLead({
            phone: normalizedPhone,
            name: name,
            email: email,
            source: source || 'manual',
            status: 'new',
            progress: 0,
            qualified: false,
            ai_paused: 0,
            post_qualification_response_sent: false,
            answers: {},
            returning_customer: false,
            times_qualified: 0
        });
        
        console.log(`✅ Lead created with ID: ${newLead.id}`);
        
        // Process initialMessage if provided (e.g., from Facebook Lead Ads)
        if (initialMessage && initialMessage.trim().length > 0) {
            console.log(`📝 Processing initial message from lead creation: "${initialMessage}"`);
            
            try {
                // Initialize answers object
                newLead.answers = newLead.answers || {};
                // Count only actual answers, not tracking fields
                const answeredCountBefore = Object.keys(newLead.answers).filter(k => !k.startsWith('_')).length;
                let newAnswersFound = 0;
                
                // Try to extract answers for ALL unanswered questions from the message
                for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                    const questionKey = `question_${i + 1}`;
                    
                    // Skip if already answered
                    if (newLead.answers[questionKey]) {
                        console.log(`   ⏭️ Question ${i + 1} already answered, skipping`);
                        continue;
                    }
                    
                    const question = CUSTOM_QUESTIONS[i];
                    const possibleAnswers = typeof question === 'object' ? question.possibleAnswers : '';
                    
                    if (!possibleAnswers) {
                        continue; // No possible answers defined, skip extraction
                    }
                    
                    // Extract answer for this question
                    const extractedAnswer = extractAnswerForQuestion(initialMessage, possibleAnswers, i + 1);
                    
                    if (extractedAnswer) {
                        // Normalize answer to lowercase for consistent storage and comparison
                        const normalizedAnswer = typeof extractedAnswer === 'string' ? extractedAnswer.toLowerCase().trim() : extractedAnswer;
                        newLead.answers[questionKey] = normalizedAnswer;
                        newAnswersFound++;
                        console.log(`   ✅ Extracted answer for Q${i + 1}: "${extractedAnswer}"`);
                    }
                }
                
                // Update progress if any new answers were found
                if (newAnswersFound > 0) {
                    // Count only actual answers, not tracking fields
                    const newAnsweredCount = Object.keys(newLead.answers).filter(k => !k.startsWith('_')).length;
                    newLead.progress = Math.round((newAnsweredCount / 4) * 100);
                    newLead.status = newLead.progress === 100 ? 'qualified' : 'active';
                    
                    // Save extracted answers to database
                    await LeadDatabase.updateLead(newLead.id, {
                        name: newLead.name,
                        email: newLead.email,
                        status: newLead.status,
                        progress: newLead.progress,
                        qualified: newLead.progress === 100,
                        ai_paused: newLead.ai_paused,
                        post_qualification_response_sent: false,
                        answers: newLead.answers,
                        qualifiedDate: newLead.progress === 100 ? new Date().toISOString() : null,
                        returning_customer: newLead.returning_customer || false,
                        times_qualified: newLead.times_qualified || 0,
                        first_qualified_date: newLead.first_qualified_date,
                        last_qualified_date: newLead.last_qualified_date
                    });
                    
                    // Update last customer message time for reminder tracking
                    await LeadDatabase.updateLastCustomerMessageTime(newLead.id, new Date().toISOString());
                    
                    console.log(`✅ Processed initial message: ${newAnswersFound} answers extracted, progress: ${newLead.progress}%`);
                    
                    // If fully qualified, send webhook
                    if (newLead.progress === 100) {
                        console.log(`🎉 Lead fully qualified from initial message!`);
                        const qualifiedLead = await LeadDatabase.getLeadById(newLead.id);
                        try {
                            await sendToCRMWebhook(qualifiedLead, 'lead_qualified', {
                                qualificationMethod: 'auto_initial_message',
                                triggeredBy: 'admin_portal',
                                meta: {
                                    initial_message_processed: true
                                }
                            });
                        } catch (error) {
                            console.error('⚠️ Failed to send webhook (non-critical):', error.message);
                        }
                    }
                }
                
                // ALWAYS reload lead after processing initialMessage to ensure fresh data for sendAIIntroduction
                newLead = await LeadDatabase.getLeadById(newLead.id);
                console.log(`🔄 Reloaded lead after initialMessage processing. Progress: ${newLead.progress}%, Answers: ${Object.keys(newLead.answers || {}).length}`);
            } catch (error) {
                console.error('⚠️ Error processing initial message (non-critical):', error.message);
                // Continue with lead creation even if message processing fails
            }
        }
        
        // Send AI introduction or qualification message (don't fail the request if this fails)
        try {
            // If lead is already fully qualified from initial message, send qualification message instead
            if (newLead.progress === 100 && newLead.qualified) {
                console.log(`🎉 Lead already qualified from initial message - sending qualification message instead of intro`);
                const qualificationMessage = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
                
                await sendSMS(newLead.phone, qualificationMessage);
                await LeadDatabase.createMessage(newLead.id, 'assistant', qualificationMessage);
            } else {
                // Send normal introduction asking first question
                await sendAIIntroduction(newLead, false); // false = new customer
            }
        } catch (introError) {
            console.error('Error sending AI introduction/qualification:', introError);
            // Don't fail the lead creation if introduction fails
        }

        res.json(newLead);
    } catch (error) {
        console.error('Error creating lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Send qualified lead to CRM
app.post('/api/leads/send-to-crm', async (req, res) => {
    try {
        const { leadId, crmWebhook } = req.body;

        if (!leadId || !crmWebhook) {
            return res.status(400).json({
                success: false,
                error: 'Lead ID and CRM webhook URL are required'
            });
        }
        
        const lead = leads.find(l => l.id == leadId);
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Prepare CRM data
        const crmData = {
            name: lead.name,
            email: lead.email,
            phone: lead.phone,
            source: lead.source,
            qualified: true,
            qualificationDate: new Date().toISOString(),
            answers: {
                question1: lead.questions.q1.answer || '',
                question2: lead.questions.q2.answer || '',
                question3: lead.questions.q3.answer || '',
                question4: lead.questions.q4.answer || ''
            }
        };
        
        // Send to CRM webhook
        const response = await fetch(crmWebhook, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(crmData)
        });
        
        if (response.ok) {
            // Mark as sent to CRM
            lead.sentToCRM = true;
            lead.crmSentDate = new Date().toISOString();

        res.json({
            success: true,
                message: 'Lead sent to CRM successfully'
            });
    } else {
            res.status(500).json({
                success: false,
                error: 'Failed to send to CRM webhook'
            });
        }
    } catch (error) {
        console.error('Error sending to CRM:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete lead
app.delete('/api/leads/:leadId', (req, res) => {
    try {
        const { leadId } = req.params;

        const lead = LeadDatabase.getLeadById(parseInt(leadId));
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Permanently delete lead from database (includes cascade delete of messages)
        LeadDatabase.deleteLead(parseInt(leadId));

        res.json({
            success: true,
            message: 'Lead deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Pause AI for a lead
app.post('/api/leads/:leadId/pause-ai', async (req, res) => {
    try {
        const { leadId } = req.params;
        
        const success = await LeadDatabase.pauseAI(parseInt(leadId));
        if (success) {
            res.json({ success: true, message: 'AI paused successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Lead not found' });
        }
    } catch (error) {
        console.error('Error pausing AI:', error);
        res.status(500).json({ success: false, message: 'Error pausing AI' });
    }
});

// Unpause AI for a lead
app.post('/api/leads/:leadId/unpause-ai', async (req, res) => {
    try {
        const { leadId } = req.params;
        
        const success = await LeadDatabase.unpauseAI(parseInt(leadId));
        if (success) {
            res.json({ success: true, message: 'AI unpaused successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Lead not found' });
        }
    } catch (error) {
        console.error('Error unpausing AI:', error);
        res.status(500).json({ success: false, message: 'Error unpausing AI' });
    }
});

// Reactivate lead from external source (Gravity Forms, Facebook Lead Gen, etc.)
app.post('/api/leads/reactivate', async (req, res) => {
    try {
        // Log incoming request for debugging
        console.log('📥 Incoming lead from external source:');
        console.log('   Headers:', JSON.stringify(req.headers, null, 2));
        console.log('   Body:', JSON.stringify(req.body, null, 2));
        console.log('   Content-Type:', req.headers['content-type']);
        
        // Handle different data formats (Make.com may send nested data)
        let phone, source, name, email, initialMessage;
        
        // Try direct field access first
        if (req.body.phone) {
            phone = req.body.phone;
            source = req.body.source;
            name = req.body.name;
            email = req.body.email;
            initialMessage = req.body.initialMessage || req.body.message || req.body.notes;
        } 
        // Try nested data (Make.com might wrap it)
        else if (req.body.data) {
            phone = req.body.data.phone;
            source = req.body.data.source;
            name = req.body.data.name;
            email = req.body.data.email;
            initialMessage = req.body.data.initialMessage || req.body.data.message || req.body.data.notes;
        }
        // Try Facebook Lead Ads format
        else if (req.body.field_data || req.body.entry) {
            // Facebook Lead Ads format
            const fieldData = req.body.field_data || (req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0]?.value?.field_data);
            if (fieldData && Array.isArray(fieldData)) {
                fieldData.forEach(field => {
                    if (field.name === 'phone_number' || field.name === 'phone') {
                        phone = field.values?.[0] || field.value;
                    } else if (field.name === 'full_name' || field.name === 'first_name') {
                        name = field.values?.[0] || field.value || name;
                    } else if (field.name === 'email') {
                        email = field.values?.[0] || field.value;
                    }
                });
                source = 'facebook_lead';
            }
        }
        // Try Make.com format variations
        else {
            // Try common Make.com field variations
            phone = req.body.phone || req.body.Phone || req.body.phone_number || req.body['Phone Number'];
            name = req.body.name || req.body.Name || req.body.full_name || req.body['Full Name'];
            email = req.body.email || req.body.Email || req.body.email_address || req.body['Email Address'];
            source = req.body.source || req.body.Source || 'facebook_lead';
            initialMessage = req.body.initialMessage || req.body.message || req.body.notes || req.body.Notes;
        }
        
        // Clean and validate phone
        if (!phone) {
            console.error('❌ Missing phone number in request body');
            console.error('   Available fields:', Object.keys(req.body));
            return res.status(400).json({
                success: false,
                error: 'Phone number is required',
                received_fields: Object.keys(req.body),
                message: 'Please ensure the webhook includes a "phone" field in the request body'
            });
        }
        
        const normalizedPhone = normalizePhoneNumber(phone);
        console.log(`🔄 New lead submission from ${source || 'external'}: ${normalizedPhone}`);
        console.log(`   Name: ${name || 'Unknown'}, Email: ${email || 'Not provided'}`);
        
        // Check if lead exists
        let lead = await LeadDatabase.checkExistingCustomer(normalizedPhone);
        
        if (lead) {
            console.log(`👤 Found existing lead: ${lead.name} (ID: ${lead.id})`);
            console.log(`   Current status: ${lead.status}, Qualified: ${lead.qualified}`);
            
            // If they're already qualified, this is a NEW inquiry - reset them
            if (lead.qualified || lead.status === 'qualified') {
                console.log(`🔄 EXISTING QUALIFIED CUSTOMER - Starting NEW inquiry (auto-reset)`);
                console.log(`   📊 Previous qualification: ${lead.qualifiedDate}`);
                console.log(`   📈 Times previously qualified: ${lead.times_qualified || 0}`);
                
                // Save previous qualification data
                const previousQualifiedDate = lead.qualifiedDate;
                
                // Reset for new qualification
                await LeadDatabase.updateLead(lead.id, {
                    name: name || lead.name,
                    email: email || lead.email,
                    source: source || lead.source,
                    status: 'new',              // Reset to new
                    progress: 0,                 // Reset progress
                    qualified: false,            // Unqualify
                    ai_paused: 0,                // Unpause AI
                    post_qualification_response_sent: false,  // Reset flag
                    answers: {},                 // Clear answers for fresh start
                    qualifiedDate: null,         // Clear current qualification
                    returning_customer: true,    // Flag as returning
                    times_qualified: (lead.times_qualified || 0) + 1,  // Increment
                    first_qualified_date: lead.first_qualified_date || previousQualifiedDate,
                    last_qualified_date: previousQualifiedDate
                });
                
                console.log(`✅ Returning customer reset for NEW inquiry:`);
                console.log(`   🔄 Returning customer: YES`);
                console.log(`   🔢 Times qualified: ${(lead.times_qualified || 0) + 1}`);
                console.log(`   📅 Last qualified: ${previousQualifiedDate}`);
                
                // Reset reminder tracking for fresh start
                try {
                    await LeadDatabase.updateLastCustomerMessageTime(lead.id, new Date().toISOString());
                    await LeadDatabase.resetReminderFlags(lead.id);
                    console.log(`🔄 Reset reminder tracking for returning customer`);
                } catch (error) {
                    console.error(`⚠️ Failed to reset reminder tracking (non-critical):`, error.message);
                }
                
                // Get fresh lead data
                lead = await LeadDatabase.getLeadById(lead.id);
                
                // Process initialMessage if provided (e.g., from Facebook Lead Ads)
                if (initialMessage && initialMessage.trim().length > 0) {
                    console.log(`📝 Processing initial message for returning customer: "${initialMessage}"`);
                    
                    try {
                        // Initialize answers object
                        lead.answers = lead.answers || {};
                        let newAnswersFound = 0;
                        
                        // Try to extract answers for ALL unanswered questions from the message
                        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                            const questionKey = `question_${i + 1}`;
                            
                            // Skip if already answered
                            if (lead.answers[questionKey]) {
                                continue;
                            }
                            
                            const question = CUSTOM_QUESTIONS[i];
                            const possibleAnswers = typeof question === 'object' ? question.possibleAnswers : '';
                            
                            if (!possibleAnswers) {
                                continue;
                            }
                            
                            // Extract answer for this question
                            const extractedAnswer = extractAnswerForQuestion(initialMessage, possibleAnswers, i + 1);
                            
                            if (extractedAnswer) {
                                // Normalize answer to lowercase for consistent storage and comparison
                                const normalizedAnswer = typeof extractedAnswer === 'string' ? extractedAnswer.toLowerCase().trim() : extractedAnswer;
                                lead.answers[questionKey] = normalizedAnswer;
                                newAnswersFound++;
                                console.log(`   ✅ Extracted answer for Q${i + 1}: "${normalizedAnswer}"`);
                            }
                        }
                        
                        // Update progress if any new answers were found
                        if (newAnswersFound > 0) {
                            // Count only actual answers, not tracking fields
                            const newAnsweredCount = Object.keys(lead.answers).filter(k => !k.startsWith('_')).length;
                            lead.progress = Math.round((newAnsweredCount / 4) * 100);
                            lead.status = lead.progress === 100 ? 'qualified' : 'active';
                            
                            // Save extracted answers to database
                            await LeadDatabase.updateLead(lead.id, {
                                name: lead.name,
                                email: lead.email,
                                status: lead.status,
                                progress: lead.progress,
                                qualified: lead.progress === 100,
                                ai_paused: lead.ai_paused,
                                post_qualification_response_sent: false,
                                answers: lead.answers,
                                qualifiedDate: lead.progress === 100 ? new Date().toISOString() : null,
                                returning_customer: lead.returning_customer || false,
                                times_qualified: lead.times_qualified || 0,
                                first_qualified_date: lead.first_qualified_date,
                                last_qualified_date: lead.last_qualified_date
                            });
                            
                            // Update last customer message time for reminder tracking
                            await LeadDatabase.updateLastCustomerMessageTime(lead.id, new Date().toISOString());
                            
                            console.log(`✅ Processed initial message: ${newAnswersFound} answers extracted, progress: ${lead.progress}%`);
                            
                            // Reload lead with updated data
                            lead = await LeadDatabase.getLeadById(lead.id);
                            
                            // If fully qualified, send webhook
                            if (lead.progress === 100) {
                                console.log(`🎉 Returning customer fully qualified from initial message!`);
                                try {
                                    await sendToCRMWebhook(lead, 'lead_qualified', {
                                        qualificationMethod: 'auto_initial_message',
                                        triggeredBy: 'api_leads_reactivate'
                                    });
                                } catch (error) {
                                    console.error('⚠️ Failed to send webhook (non-critical):', error.message);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('⚠️ Error processing initial message (non-critical):', error.message);
                    }
                }
                
                // Notify automation about returning customer event
                try {
                    await sendToCRMWebhook(lead, 'lead_returning_customer', {
                        triggeredBy: 'api_leads_reactivate',
                        meta: {
                            previous_qualified_date: previousQualifiedDate
                        }
                    });
                } catch (error) {
                    console.error('⚠️ Failed to send returning customer webhook (non-critical):', error.message);
                }
                
                // Send AI introduction or qualification message for the NEW inquiry
                try {
                    // If lead is already fully qualified from initial message, send qualification message instead
                    if (lead.progress === 100 && lead.qualified) {
                        console.log(`🎉 Returning customer already qualified from initial message - sending qualification message instead of intro`);
                        const qualificationMessage = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
                        
                        await sendSMS(lead.phone, qualificationMessage);
                        await LeadDatabase.createMessage(lead.id, 'assistant', qualificationMessage);
                    } else {
                        // Send normal introduction asking first question
                        await sendAIIntroduction(lead, true); // Pass true for "returning customer"
                    }
                } catch (introError) {
                    console.error('Error sending AI introduction/qualification:', introError);
                }
                
                res.json({
                    success: true,
                    message: 'Returning customer - started fresh qualification',
                    leadId: lead.id,
                    action: 'restarted',
                    returning_customer: true,
                    times_qualified: lead.times_qualified
                });
            } else {
                // Lead exists but not qualified yet - just update details and unpause
                console.log(`📝 Updating existing unqualified lead - continuing qualification`);
                
                await LeadDatabase.updateLead(lead.id, {
                    name: name || lead.name,
                    email: email || lead.email,
                    source: source || lead.source,
                    status: lead.status,
                    progress: lead.progress,
                    qualified: lead.qualified,
                    ai_paused: 0,  // Unpause in case it was paused
                    post_qualification_response_sent: lead.post_qualification_response_sent || false,
                    answers: lead.answers,
                    qualifiedDate: lead.qualifiedDate,
                    returning_customer: lead.returning_customer || false,
                    times_qualified: lead.times_qualified || 0,
                    first_qualified_date: lead.first_qualified_date,
                    last_qualified_date: lead.last_qualified_date
                });
                
                await LeadDatabase.updateLastContact(lead.id);
                
                console.log(`✅ Lead updated and AI unpaused - continuing qualification`);
                
                res.json({
                    success: true,
                    message: 'Existing lead updated - continuing qualification',
                    leadId: lead.id,
                    action: 'updated'
                });
            }
        } else {
            // Create new lead
            console.log(`🆕 Creating NEW lead from external source: ${normalizedPhone}`);
            
            lead = await LeadDatabase.createLead({
                phone: normalizedPhone,
                name: name || 'Unknown',
                email: email || '',
                source: source || 'external',
                status: 'new',
                progress: 0,
                qualified: false,
                ai_paused: 0,
                returning_customer: false,
                times_qualified: 0
            });
            
            console.log(`✅ New lead created: ${lead.name} (ID: ${lead.id})`);
            
            // Process initialMessage if provided (e.g., from Facebook Lead Ads)
            if (initialMessage && initialMessage.trim().length > 0) {
                console.log(`📝 Processing initial message from lead creation: "${initialMessage}"`);
                
                try {
                    // Initialize answers object
                    lead.answers = lead.answers || {};
                    let newAnswersFound = 0;
                    
                    // Try to extract answers for ALL unanswered questions from the message
                    for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                        const questionKey = `question_${i + 1}`;
                        
                        // Skip if already answered
                        if (lead.answers[questionKey]) {
                            continue;
                        }
                        
                        const question = CUSTOM_QUESTIONS[i];
                        const possibleAnswers = typeof question === 'object' ? question.possibleAnswers : '';
                        
                        if (!possibleAnswers) {
                            continue;
                        }
                        
                        // Extract answer for this question
                        const extractedAnswer = extractAnswerForQuestion(initialMessage, possibleAnswers, i + 1);
                        
                        if (extractedAnswer) {
                            // Normalize answer to lowercase for consistent storage and comparison
                            const normalizedAnswer = typeof extractedAnswer === 'string' ? extractedAnswer.toLowerCase().trim() : extractedAnswer;
                            lead.answers[questionKey] = normalizedAnswer;
                            newAnswersFound++;
                            console.log(`   ✅ Extracted answer for Q${i + 1}: "${normalizedAnswer}"`);
                        }
                    }
                    
                    // Update progress if any new answers were found
                    if (newAnswersFound > 0) {
                        // Count only actual answers, not tracking fields
                        const newAnsweredCount = Object.keys(lead.answers).filter(k => !k.startsWith('_')).length;
                        lead.progress = Math.round((newAnsweredCount / 4) * 100);
                        lead.status = lead.progress === 100 ? 'qualified' : 'active';
                        
                        // Save extracted answers to database
                        await LeadDatabase.updateLead(lead.id, {
                            name: lead.name,
                            email: lead.email,
                            status: lead.status,
                            progress: lead.progress,
                            qualified: lead.progress === 100,
                            ai_paused: lead.ai_paused,
                            post_qualification_response_sent: false,
                            answers: lead.answers,
                            qualifiedDate: lead.progress === 100 ? new Date().toISOString() : null,
                            returning_customer: lead.returning_customer || false,
                            times_qualified: lead.times_qualified || 0,
                            first_qualified_date: lead.progress === 100 ? new Date().toISOString() : null,
                            last_qualified_date: lead.progress === 100 ? new Date().toISOString() : null
                        });
                        
                        // Update last customer message time for reminder tracking
                        await LeadDatabase.updateLastCustomerMessageTime(lead.id, new Date().toISOString());
                        
                        console.log(`✅ Processed initial message: ${newAnswersFound} answers extracted, progress: ${lead.progress}%`);
                        
                        // Reload lead with updated data
                        lead = await LeadDatabase.getLeadById(lead.id);
                        
                        // If fully qualified, send webhook
                        if (lead.progress === 100) {
                            console.log(`🎉 Lead fully qualified from initial message!`);
                            try {
                                await sendToCRMWebhook(lead, 'lead_qualified', {
                                    qualificationMethod: 'auto_initial_message',
                                    triggeredBy: 'api_leads_reactivate'
                                });
                            } catch (error) {
                                console.error('⚠️ Failed to send webhook (non-critical):', error.message);
                            }
                        }
                    }
                } catch (error) {
                    console.error('⚠️ Error processing initial message (non-critical):', error.message);
                }
            }
            
            // Send AI introduction or qualification message (don't fail the request if this fails)
            try {
                // If lead is already fully qualified from initial message, send qualification message instead
                if (lead.progress === 100 && lead.qualified) {
                    console.log(`🎉 Lead already qualified from initial message - sending qualification message instead of intro`);
                    const qualificationMessage = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
                    
                    await sendSMS(lead.phone, qualificationMessage);
                    await LeadDatabase.createMessage(lead.id, 'assistant', qualificationMessage);
                } else {
                    // Send normal introduction asking first question
                    await sendAIIntroduction(lead, false); // false = new customer
                }
            } catch (introError) {
                console.error('Error sending AI introduction/qualification:', introError);
                // Don't fail the lead creation if introduction fails
            }
            
            res.json({
                success: true,
                message: 'New lead created successfully',
                leadId: lead.id,
                action: 'created'
            });
        }
    } catch (error) {
        console.error('❌ Error processing external lead:', error);
        console.error('   Stack:', error.stack);
        console.error('   Request body:', JSON.stringify(req.body, null, 2));
        console.error('   Request headers:', JSON.stringify(req.headers, null, 2));
        
        // Return detailed error for debugging
        res.status(500).json({
            success: false,
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
            message: 'Failed to process external lead. Please check the webhook format and ensure all required fields are present.'
        });
    }
});

// SMS Webhook - Handle incoming messages
app.post('/webhook/sms', async (req, res) => {
    try {
        console.log('🔔 Webhook received!');
        console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
        console.log('📦 Request headers:', JSON.stringify(req.headers, null, 2));
        
        const { Body, From, To, MessageSid } = req.body;
        
        if (!From || !Body) {
            console.log('❌ Missing required fields in webhook');
            return res.status(400).send('Missing required fields');
        }
        
        console.log(`📥 Incoming SMS from ${From}: "${Body}"`);
        
        const normalizedPhone = normalizePhoneNumber(From);
        console.log(`📞 Normalized phone: ${normalizedPhone}`);
        
        // Check if customer already exists in database
        let lead = await LeadDatabase.checkExistingCustomer(normalizedPhone);
        
        if (!lead) {
            // New customer - create in database
            console.log(`🆕 Creating new lead for ${normalizedPhone}`);
            lead = await LeadDatabase.createLead({
                phone: normalizedPhone,
                name: 'Unknown',
                email: '',
                source: 'inbound_sms',
                status: 'new',
                progress: 0,
                qualified: false,
                ai_paused: 0,
                post_qualification_response_sent: false,
                answers: {},
                returning_customer: false,
                times_qualified: 0
            });
            console.log(`✅ New lead created with ID: ${lead.id}`);
        } else {
            // Returning customer - load conversation history
            console.log(`🔄 Existing customer found: ${lead.name} (ID: ${lead.id})`);
            console.log(`   Status: ${lead.status}, Progress: ${lead.progress}%`);
            
            const messageHistory = await LeadDatabase.getConversationHistory(lead.id);
            console.log(`   📜 Loaded ${messageHistory.length} previous messages`);
            
            // Update last contact time
            await LeadDatabase.updateLastContact(lead.id);
        }
        
        // Process AI response
        console.log('🤖 Processing AI response...');
        await processAIResponse(lead, Body);
        
        console.log('✅ Webhook processed successfully');
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            } catch (error) {
        console.error('❌ Error processing webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Test webhook endpoint
app.get('/webhook/test', (req, res) => {
    res.json({
        status: 'Webhook endpoint is working',
        timestamp: new Date().toISOString(),
        leads: leads.length,
        messages: messages.length
    });
});

// Configuration status endpoint
app.get('/api/config/status', (req, res) => {
    res.json({
        openai: {
            apiKey: process.env.OPENAI_API_KEY ? 'Set' : 'Not set',
            assistantId: process.env.OPENAI_ASSISTANT_ID ? process.env.OPENAI_ASSISTANT_ID : 'Not set',
            model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo'
        },
        twilio: {
            accountSid: process.env.TWILIO_ACCOUNT_SID ? 'Set' : 'Not set',
            authToken: process.env.TWILIO_AUTH_TOKEN ? 'Set' : 'Not set',
            fromNumber: process.env.TWILIO_FROM_NUMBER ? process.env.TWILIO_FROM_NUMBER : 'Not set'
        },
        customQuestions: CUSTOM_QUESTIONS,
        timestamp: new Date().toISOString()
    });
});

// Database status endpoint (for debugging persistence issues)
app.get('/api/database/status', (req, res) => {
    try {
        const leads = LeadDatabase.getAllLeads();
        const totalLeads = leads.length;
        const totalMessages = leads.reduce((total, lead) => {
            const messages = LeadDatabase.getMessagesByLeadId(lead.id);
            return total + messages.length;
        }, 0);
        
        const status = {
            databasePath: process.env.DATABASE_PATH || '/tmp/leads.db',
            railwayVolume: process.env.RAILWAY_VOLUME_MOUNT_PATH || 'Not set',
            totalLeads: totalLeads,
            totalMessages: totalMessages,
            leads: leads.map(lead => ({
                id: lead.id,
                name: lead.name,
                phone: lead.phone,
                status: lead.status,
                messageCount: LeadDatabase.getMessagesByLeadId(lead.id).length
            }))
        };
        
        res.json(status);
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            databasePath: process.env.DATABASE_PATH || '/tmp/leads.db',
            railwayVolume: process.env.RAILWAY_VOLUME_MOUNT_PATH || 'Not set'
        });
    }
});

// Database status endpoint (for debugging)
app.get('/api/database/status', (req, res) => {
    try {
        const leads = LeadDatabase.getAllLeads();
        const totalMessages = leads.reduce((sum, lead) => {
            const messages = LeadDatabase.getMessagesByLeadId(lead.id);
            return sum + messages.length;
        }, 0);
        
        res.json({
            success: true,
            database: 'SQLite',
            totalLeads: leads.length,
            totalMessages: totalMessages,
            leads: leads.map(lead => ({
                id: lead.id,
                name: lead.name,
                phone: lead.phone,
                status: lead.status,
                progress: lead.progress,
                qualified: lead.qualified,
                answeredQuestions: Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length,
                createdAt: lead.createdAt
            })),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error getting database status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test webhook with sample data
app.post('/webhook/test', async (req, res) => {
    try {
        console.log('🧪 Test webhook called');
        
        // Simulate incoming SMS
        const testData = {
            Body: 'Hello, this is a test message',
            From: '+447809505864',
            To: process.env.TWILIO_FROM_NUMBER || '+1234567890',
            MessageSid: 'test-message-sid'
        };
        
        console.log('📦 Test data:', testData);
        
        // Process the test message
        const normalizedPhone = normalizePhoneNumber(testData.From);
        console.log(`📞 Normalized test phone: ${normalizedPhone}`);
        
        // Get or create lead
        let lead = leads.find(l => l.phone === normalizedPhone);
        if (!lead) {
            lead = {
                id: leadIdCounter++,
                name: 'Test Lead',
                email: 'test@example.com',
                phone: normalizedPhone,
                source: 'test',
                status: 'new',
                progress: 0,
                qualified: false,
                answers: {},
                createdAt: new Date().toISOString()
            };
            leads.push(lead);
        }
        
        // Process AI response
        await processAIResponse(lead, testData.Body);

        res.json({
            success: true,
            message: 'Test webhook processed successfully',
            lead: lead,
            totalLeads: leads.length,
            totalMessages: messages.length
        });
    } catch (error) {
        console.error('❌ Error in test webhook:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ========================================
// HELPER FUNCTIONS
// ========================================

// Send AI introduction message
async function sendAIIntroduction(lead, isReturning = false) {
    try {
        console.log(`👋 Sending AI introduction to ${lead.name}...`);
        
        // Get lead source display name
        let sourceDisplay = '';
        if (lead.source) {
            try {
                const sourceMapping = await LeadDatabase.getSourceByTechnicalId(lead.source);
                if (sourceMapping && sourceMapping.display_name) {
                    sourceDisplay = ` via ${sourceMapping.display_name}`;
                }
            } catch (error) {
                console.log(`⚠️ Could not get source mapping for ${lead.source}:`, error.message);
            }
        }
        
        // Check if lead already has some answers (e.g., from initialMessage)
        // Count only actual answers, not tracking fields
        const answeredCount = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
        const hasAnswers = answeredCount > 0;
        
        // Find the first unanswered question (or Q1 if none answered yet)
        const nextQuestion = findFirstUnansweredQuestion(lead);
        if (!nextQuestion) {
            console.log(`   ⚠️ No question to ask - all questions answered or all have been asked`);
            // If all questions answered, send qualification message
            const qualificationMsg = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
            await sendSMS(lead.phone, qualificationMsg);
            await LeadDatabase.createMessage(lead.id, 'assistant', qualificationMsg);
            return;
        }
        
        const questionText = nextQuestion;
        
        // Find which question number this is
        let questionNumber = -1;
        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
            const q = CUSTOM_QUESTIONS[i];
            const qText = typeof q === 'object' ? q.question : q;
            if (qText === questionText) {
                questionNumber = i + 1;
                break;
            }
        }
        
        console.log(`   📊 Lead has ${answeredCount} answers already`);
        console.log(`   ❓ Next question to ask: Q${questionNumber} - "${questionText}"`);
        
        // CRITICAL: Mark this question as asked BEFORE sending
        if (!lead.answers) {
            lead.answers = {};
        }
        if (!lead.answers._questions_asked) {
            lead.answers._questions_asked = {};
        }
        lead.answers._questions_asked[`question_${questionNumber}`] = true;
        
        // Save the "asked" flag to database immediately
        await LeadDatabase.updateLead(lead.id, {
            name: lead.name,
            email: lead.email,
            status: lead.status,
            progress: lead.progress,
            qualified: lead.qualified,
            ai_paused: lead.ai_paused,
            post_qualification_response_sent: lead.post_qualification_response_sent,
            answers: lead.answers,
            qualifiedDate: lead.qualifiedDate,
            returning_customer: lead.returning_customer || false,
            times_qualified: lead.times_qualified || 0,
            first_qualified_date: lead.first_qualified_date,
            last_qualified_date: lead.last_qualified_date
        });
        
        console.log(`   ✅ Marked Q${questionNumber} as asked in introduction - will NEVER ask this question again`);
        
        let introMessage;
        
        if (lead.progress === 100) {
            // All questions answered - send qualification message instead
            introMessage = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
        } else if (hasAnswers) {
            // Lead already has some answers - welcome and ask next question
            if (isReturning) {
                introMessage = `Hi ${lead.name}! Great to hear from you again!${sourceDisplay} 👋

I see you have a new inquiry. ${questionText}`;
            } else {
                introMessage = `Hi ${lead.name}! 👋 

I'm ${ASSISTANT_NAME}, your AI assistant from CSGB Cheshire Stables. I'm here to help you find the perfect equine stable solution.

${questionText}`;
            }
        } else {
            // No answers yet - standard introduction with first question
            if (isReturning) {
                // Personalized message for returning customers
                introMessage = `Hi ${lead.name}! Great to hear from you again!${sourceDisplay} 👋

I see you have a new inquiry. Let me ask you a few quick questions about your current needs so we can help you properly.

${questionText}`;
            } else {
                // Standard welcome for new customers
                introMessage = `Hi ${lead.name}! 👋 

I'm ${ASSISTANT_NAME}, your AI assistant from CSGB Cheshire Stables. I'm here to help you find the perfect equine stable solution.

${questionText}`;
            }
        }
        
        await sendSMS(lead.phone, introMessage);
        
        // Store introduction message in database
        await LeadDatabase.createMessage(lead.id, 'assistant', introMessage);
        
        console.log(`✅ AI introduction sent${isReturning ? ' (returning customer)' : ''}`);
        console.log(`📝 Question asked: ${questionText}`);
    } catch (error) {
        console.error('❌ Error sending AI introduction:', error);
        throw error;
    }
}

// Extract answer for a specific question from the user's message
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractClauseForMatch(message, start, end) {
    if (start === undefined || end === undefined || start < 0 || end < 0) {
        return '';
    }

    const clauseRegex = /[^.!?\n\r]+[.!?\n\r]?/g;
    let clauseMatch;
    while ((clauseMatch = clauseRegex.exec(message)) !== null) {
        const clauseStart = clauseMatch.index;
        const clauseEnd = clauseStart + clauseMatch[0].length;
        if (start >= clauseStart && end <= clauseEnd) {
            let clause = clauseMatch[0].trim();
            clause = clause.replace(/^[\s,;:\-]+/, '').replace(/[\s,;:\-]+$/, '');
            clause = clause.replace(/^(and|but|so|then|also)\s+/i, '').trim();
            return clause;
        }
    }

    const windowPadding = 80;
    const fallbackStart = Math.max(0, start - windowPadding);
    const fallbackEnd = Math.min(message.length, end + windowPadding);
    let fallback = message.slice(fallbackStart, fallbackEnd).trim();
    fallback = fallback.replace(/^[\s,;:\-]+/, '').replace(/[\s,;:\-]+$/, '');
    fallback = fallback.replace(/^(and|but|so|then|also)\s+/i, '').trim();
    return fallback || message.slice(start, end).trim();
}

function cleanAnswerResult(text) {
    if (!text) return '';
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^[\s,;:\-]+/, '').replace(/[\s,;:\-]+$/, '');
    cleaned = cleaned.replace(/^(and|but|so|then|also)\s+/i, '').trim();
    return cleaned;
}

function extractAnswerForQuestion(userMessage, possibleAnswers, questionNumber) {
    if (!userMessage || !possibleAnswers) return null;
    
    const originalMessage = userMessage.trim();
    if (originalMessage.length === 0) return null;

    const messageLower = originalMessage.toLowerCase();
    const expectedList = possibleAnswers
        .toLowerCase()
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
    
    console.log(`      🔍 Checking Q${questionNumber} against: "${originalMessage}"`);
    console.log(`      📋 Looking for: ${expectedList.join(', ')}`);

    let bestMatch = null;

    const recordMatch = (matchedText, startIndex, endIndex, reason = '') => {
        if (matchedText === undefined || matchedText === null) return;
        const trimmedMatch = matchedText.trim();
        if (trimmedMatch.length === 0) return;
        const length = trimmedMatch.length;

        if (!bestMatch || length > bestMatch.length) {
            bestMatch = {
                text: trimmedMatch,
                start: startIndex,
                end: endIndex,
                length,
                reason
            };
        }
    };

    // Special handling for postcode question (usually question 4)
    if (possibleAnswers.toLowerCase().includes('postcode') || 
        possibleAnswers.toLowerCase().includes('any postcode format')) {
        const collectionKeywords = [
            'collection', 'collect', 'pickup', 'pick up', 'pick-up', 
            'ill get it', "i'll get it", 'i will get it', 'getting it',
            'ill collect', "i'll collect", 'i will collect'
        ];

        for (const keyword of collectionKeywords) {
            const keywordRegex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'gi');
            let match;
            while ((match = keywordRegex.exec(originalMessage)) !== null) {
                recordMatch(match[0], match.index, keywordRegex.lastIndex, 'collection keyword');
            }
        }
        
        for (const pattern of POSTCODE_PATTERNS) {
            let match;
            while ((match = pattern.exec(originalMessage)) !== null) {
                const matchedText = match[0].toUpperCase();
                // Validate: must have at least 1 letter and 1 number
                if (isValidPostcodeFormat(matchedText)) {
                    recordMatch(matchedText, match.index, pattern.lastIndex, 'postcode pattern');
                }
            }
        }
        
        const postcodeTextRegex = /postcode[:\s]+([A-Z0-9\s]{4,9})/gi;
        let postcodeTextMatch;
        while ((postcodeTextMatch = postcodeTextRegex.exec(originalMessage)) !== null) {
            const extracted = postcodeTextMatch[0].replace(/postcode[:\s]+/gi, '').trim().toUpperCase();
            // Validate: must have at least 2 letters and 1 number
            if (isValidPostcodeFormat(extracted)) {
                recordMatch(extracted, postcodeTextMatch.index, postcodeTextRegex.lastIndex, 'postcode text match');
            }
        }
    }
    
    // Check for exact word/phrase matches from expected answers
    for (const expected of expectedList) {
        if (expected.length < 2) continue;
        if (expected === 'blank' || expected === 'unsure' || expected === 'not') continue;

        const expectedRegex = new RegExp(`\\b${escapeRegex(expected)}\\b`, 'gi');
        let match;
        while ((match = expectedRegex.exec(originalMessage)) !== null) {
            recordMatch(match[0], match.index, expectedRegex.lastIndex, `expected:${expected}`);
            console.log(`      🔍 Found exact match: "${match[0]}" for expected: "${expected}"`);
        }
    }
    
    const variations = {
        'mobile': ['movable', 'moveable', 'portable', 'transportable', 'skids', 'towable', 'on skids'],
        'static': ['fixed', 'permanent', 'stationary', 'not mobile', 'non-mobile'],
        'asap': ['as soon as possible', 'urgent', 'urgently', 'quickly', 'fast', 'immediately', 'right away', 'soon', 'soonest'],
        'week': ['1 week', 'a week', 'one week', 'this week', 'next week', 'within a week', 'in a week'],
        'weeks': ['2 weeks', 'two weeks', 'few weeks', 'couple weeks', 'several weeks', 'within weeks'],
        'month': ['1 month', 'a month', 'one month', 'this month', 'next month', 'within a month', 'in a month'],
        'months': ['2 months', 'two months', 'few months', 'couple months', 'several months', '3 months', 'three months'],
        'day': ['today', 'tomorrow', '1 day', 'a day', 'one day', 'within a day'],
        'days': ['2 days', 'few days', 'couple days', 'several days', 'within days'],
        'yes': ['yeah', 'yep', 'sure', 'definitely', 'absolutely'],
        'no': ['nope', 'nah', 'not really', 'negative']
    };
    
    for (const [key, variants] of Object.entries(variations)) {
        if (!expectedList.includes(key)) continue;
        for (const variant of variants) {
            const variantRegex = new RegExp(`\\b${escapeRegex(variant)}\\b`, 'gi');
            let match;
            while ((match = variantRegex.exec(originalMessage)) !== null) {
                recordMatch(match[0], match.index, variantRegex.lastIndex, `variant:${variant}`);
                console.log(`      🔍 Found variation match: "${match[0]}" for key: "${key}" (variant: "${variant}")`);
            }
        }
    }
    
    if (bestMatch) {
        const expanded = extractClauseForMatch(originalMessage, bestMatch.start, bestMatch.end);
        let cleanedResult = cleanAnswerResult(expanded || bestMatch.text);

        if (questionNumber === 1) {
            const dimensionMatch = findNearestDimension(originalMessage, bestMatch.start);
            cleanedResult = stripPatterns(cleanedResult, TIMEFRAME_PATTERNS);
            cleanedResult = stripPostcodes(cleanedResult);
            cleanedResult = stripTrailingConnectors(cleanedResult);
            if (!cleanedResult || cleanedResult.length === 0) {
                cleanedResult = cleanAnswerResult(expanded);
            }
            if (!cleanedResult || cleanedResult.length === 0) {
                cleanedResult = cleanAnswerResult(bestMatch.text);
            }
            if (dimensionMatch) {
                const lowerClean = (cleanedResult || '').toLowerCase();
                const lowerDim = dimensionMatch.text.toLowerCase();
                if (!lowerClean.includes(lowerDim)) {
                    cleanedResult = cleanAnswerResult(`${dimensionMatch.text} ${cleanedResult || ''}`.trim());
                }
            }
        } else if (questionNumber === 2) {
            cleanedResult = cleanAnswerResult(bestMatch.text);
            if (/\b(stable|stables|barn|shelter|building)\b/i.test(expanded)) {
                const nearby = expanded.match(/\b(?:mobile|static|permanent|fixed|portable|movable|moveable)\b\s*(?:stable|stables|barn|shelter|building|block)?/i);
                if (nearby) {
                    cleanedResult = cleanAnswerResult(nearby[0]);
                }
            }
        } else if (questionNumber === 3) {
            const timeframeMatch = expanded.match(/\b(?:asap|urgent|urgently|immediately|quickly|soon|soonest|right away|straight away|today|tomorrow|tonight|end of the month|over the weekend)\b/i) ||
                expanded.match(/\b(?:next|this|within|in)\s+(?:day|week|month|year|couple of weeks|couple of months|couple of days)\b/i) ||
                expanded.match(/\b(?:few|couple of|couple|several)\s+(?:days|weeks|months)\b/i) ||
                expanded.match(/\b\d+\s*(?:day|days|week|weeks|month|months|year|years)\b/i);
            if (timeframeMatch) {
                cleanedResult = cleanAnswerResult(timeframeMatch[0]);
            } else {
                cleanedResult = cleanAnswerResult(bestMatch.text);
            }
        } else if (questionNumber === 4) {
            // Check for collection keywords first
            const collectionKeywords = ['collection', 'collect', 'pickup', 'pick up', 'pick-up', 
                'ill get it', "i'll get it", 'i will get it', 'getting it',
                'ill collect', "i'll collect", 'i will collect'];
            const isCollectionKeyword = collectionKeywords.some(keyword => 
                new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'gi').test(expanded || bestMatch.text)
            );
            
            if (isCollectionKeyword) {
                // Extract the collection keyword
                for (const keyword of collectionKeywords) {
                    const keywordRegex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'gi');
                    const match = (expanded || bestMatch.text).match(keywordRegex);
                    if (match) {
                        cleanedResult = match[0];
                        break;
                    }
                }
            } else {
                // Only accept valid postcodes - reject "No" and other non-postcode answers
                const postcodeMatch = expanded.match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/i) || expanded.match(/\b[A-Z]{1,}\d{1,}[A-Z]?\b/i);
                if (postcodeMatch && isValidPostcodeFormat(postcodeMatch[0])) {
                    cleanedResult = postcodeMatch[0].toUpperCase();
                } else {
                    // Reject common non-postcode answers like "No", "Yes", etc.
                    const rejectedAnswers = ['no', 'yes', 'nope', 'nah', 'yeah', 'yep', 'sure', 'ok', 'okay'];
                    const bestMatchLower = (bestMatch.text || '').toLowerCase().trim();
                    if (rejectedAnswers.includes(bestMatchLower)) {
                        console.log(`      ⏩ Rejecting non-postcode answer "${bestMatch.text}" for question 4`);
                        return null; // Don't accept this as a postcode answer
                    }
                    // Only use bestMatch if it looks like it could be a postcode
                    const potentialPostcode = cleanAnswerResult(bestMatch.text.toUpperCase());
                    if (isValidPostcodeFormat(potentialPostcode)) {
                        cleanedResult = potentialPostcode;
                    } else {
                        console.log(`      ⏩ Rejecting "${bestMatch.text}" - not a valid postcode format`);
                        return null; // Don't accept non-postcode answers
                    }
                }
            }
        }

        cleanedResult = stripTrailingConnectors(cleanedResult);

        if (cleanedResult) {
            console.log(`      ✅ Final match selected: "${cleanedResult}"${bestMatch.reason ? ` (${bestMatch.reason})` : ''}`);
            return cleanedResult;
        }

        console.log(`      ✅ Final match selected: "${bestMatch.text}"${bestMatch.reason ? ` (${bestMatch.reason})` : ''}`);
        return cleanAnswerResult(bestMatch.text);
    }
    
    console.log('      ❌ No match found - returning null (no false positive)');
    return null;
}

// Validate if user answer matches expected patterns (flexible matching)
function validateAnswer(userMessage, expectedAnswers) {
    if (!userMessage || !expectedAnswers) return false;
    
    const userAnswer = userMessage.toLowerCase().trim();
    const expectedList = expectedAnswers.toLowerCase().split(',').map(a => a.trim());
    
    console.log(`      🔍 Validating: "${userMessage}" against expected: ${expectedList.join(', ')}`);
    
    // Check for exact matches
    if (expectedList.includes(userAnswer)) {
        console.log(`      ✅ Exact match found`);
        return true;
    }
    
    // Check for partial matches (user answer contains expected answer)
    for (const expected of expectedList) {
        if (expected.length < 2) continue; // Skip single characters
        if (userAnswer.includes(expected) || expected.includes(userAnswer)) {
            console.log(`      ✅ Partial match found: ${expected}`);
            return true;
        }
    }
    
    // Check for common variations (using word boundaries to prevent substring matches)
    const variations = {
        'yes': ['yeah', 'yep', 'sure', 'ok', 'okay', 'definitely', 'absolutely'],  // Removed 'y' to prevent false matches
        'no': ['nope', 'nah', 'not', 'none', 'never'],  // Removed 'n' for same reason
        'mobile': ['movable', 'moveable', 'portable', 'transportable', 'skids', 'towable'],
        'static': ['fixed', 'permanent', 'stationary'],
        'asap': ['as soon as possible', 'urgent', 'urgently', 'quickly', 'fast', 'immediately', 'soon', 'soonest'],
        'week': ['weeks', 'weekly', '1 week', 'a week'],
        'month': ['months', 'monthly', '1 month', 'a month'],
        'year': ['years', 'yearly']
    };
    
    for (const [key, variants] of Object.entries(variations)) {
        if (expectedList.includes(key)) {
            for (const variant of variants) {
                // Use word boundary to prevent substring matches
                const regex = new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
                if (regex.test(userAnswer)) {
                    console.log(`      ✅ Variation match found: ${key} (matched: ${variant})`);
                    return true;
                }
            }
        }
    }
    
    // For postcode question, accept any format that looks like a postcode OR collection keywords
    if (expectedList.includes('any postcode format') || expectedAnswers.toLowerCase().includes('postcode')) {
        // Check for collection/pickup keywords
        const collectionKeywords = [
            'collection', 'collect', 'pickup', 'pick up', 'pick-up', 
            'ill get it', "i'll get it", 'i will get it', 'getting it',
            'ill collect', "i'll collect", 'i will collect'
        ];
        
        for (const keyword of collectionKeywords) {
            if (userAnswer.includes(keyword.toLowerCase())) {
                console.log(`      ✅ Collection keyword match found`);
                return true;
            }
        }
        
        // More lenient postcode patterns - but must have at least 1 letter and 1 number
        const postcodePatterns = [
            /^[a-z]{1,2}\d{1,2}[a-z]?\s?\d[a-z]{2}$/i,  // Standard UK format
            /^[a-z]{2}\d\s?\d[a-z]{2}$/i,               // Simplified format
            /\b[a-z]{1,}\d{1,}\s?\d[a-z]{2}\b/gi,       // Embedded in text - requires 1+ letters
            /\b[a-z]{1,}\d{1,}[a-z]?\b/gi               // Short format - requires 1+ letters and 1+ numbers
        ];
        
        for (const pattern of postcodePatterns) {
            const match = userAnswer.match(pattern);
            if (match) {
                // Validate: must have at least 1 letter and 1 number
                if (isValidPostcodeFormat(match[0])) {
                    console.log(`      ✅ Postcode pattern match found: ${match[0]}`);
                    return true;
                }
            }
        }
    }
    
    // If answer is substantial (more than 2 characters) and not just numbers, accept it
    if (userAnswer.length > 2 && userAnswer.length < 50) {
        console.log(`      ✅ Substantial answer accepted (${userAnswer.length} chars)`);
        return true;
    }
    
    console.log(`      ❌ No match found - answer rejected`);
    return false;
}

// Process AI response using OpenAI Assistant
async function processAIResponse(lead, userMessage) {
    try {
        console.log(`🔄 Processing AI response for lead: ${lead.name} (${lead.phone})`);
        console.log(`📝 User message: "${userMessage}"`);
        
        // Check if AI is paused for this lead
        if (lead.ai_paused === 1 || lead.ai_paused === true) {
            console.log(`⏸️ AI is paused for this lead - no response will be sent`);
            console.log(`📝 Message stored but no AI response generated`);
            return; // Exit without sending AI response
        }
        
        // Store incoming message in database
        await LeadDatabase.createMessage(lead.id, 'customer', userMessage);
        
        // Update last customer message time for reminder tracking
        try {
            await LeadDatabase.updateLastCustomerMessageTime(lead.id, new Date().toISOString());
            console.log(`✅ Updated last message time for reminder tracking`);
        } catch (error) {
            console.error(`⚠️ Failed to update last message time (non-critical):`, error.message);
        }
        
        // Handle YES/NO responses to 48hr reminder FIRST (before resetting flags!)
        // Only check for very short messages to avoid false positives
        if (lead.reminder_48hr_sent && userMessage.trim().length <= 10) {
            const response = userMessage.toLowerCase().trim();
            if (response === 'yes' || response === 'yeah' || response === 'yep' || response === 'y') {
                console.log(`✅ Lead confirmed interest after 48hr reminder - continuing qualification`);
                
                // Send acknowledgment + next question
                const nextQuestion = findFirstUnansweredQuestion(lead);
                if (!nextQuestion) {
                    // All questions asked or answered - send qualification message
                    const qualificationMsg = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;
                    await sendSMS(lead.phone, qualificationMsg);
                    await LeadDatabase.createMessage(lead.id, 'assistant', qualificationMsg);
                    return;
                }
                
                const nextQuestionText = typeof nextQuestion === 'object' ? nextQuestion.question : nextQuestion;
                
                // Find which question number this is and mark it as asked
                let questionNumber = -1;
                for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                    const q = CUSTOM_QUESTIONS[i];
                    const qText = typeof q === 'object' ? q.question : q;
                    if (qText === nextQuestionText) {
                        questionNumber = i + 1;
                        break;
                    }
                }
                
                // Mark as asked
                if (!lead.answers._questions_asked) {
                    lead.answers._questions_asked = {};
                }
                lead.answers._questions_asked[`question_${questionNumber}`] = true;
                console.log(`   ✅ Marked Q${questionNumber} as asked in re-engagement - will NEVER ask again`);
                
                const reengageMsg = `Great! Thanks for confirming. Let me help you get that quote sorted. ${nextQuestionText}`;
                
                try {
                    await sendSMS(lead.phone, reengageMsg);
                    await LeadDatabase.createMessage(lead.id, 'assistant', reengageMsg);
                    console.log(`📤 Sent re-engagement message to ${lead.phone}`);
                } catch (error) {
                    console.error(`⚠️ Error sending re-engagement message:`, error.message);
                }
                return; // Stop further processing (we already sent the response)
                
            } else if (response === 'no' || response === 'nope' || response === 'not interested' || response === 'n') {
                console.log(`❌ Lead declined after 48hr reminder - closing conversation`);
                try {
                    await LeadDatabase.updateLead(lead.id, { 
                        ...lead, 
                        status: 'closed', 
                        ai_paused: 1 
                    });
                    const closingMsg = "We appreciate you letting us know. Feel free to contact us anytime in the future! \nKeep and eye on our social media for future SPECIAL OFFERS!! Or visit our website: https://www.csgbgroup.co.uk/cheshire-stables";
                    await sendSMS(lead.phone, closingMsg);
                    await LeadDatabase.createMessage(lead.id, 'assistant', closingMsg);
                } catch (error) {
                    console.error(`⚠️ Error closing lead after NO response:`, error.message);
                }
                return; // Stop processing
            }
        }
        
        // Reset reminder flags if customer responds (they're engaged again)
        // Only reset AFTER checking YES/NO to 48hr reminder above
        if (lead.reminder_1hr_sent || lead.reminder_24hr_sent || lead.reminder_48hr_sent) {
            console.log(`🔄 Customer responded - resetting reminder flags`);
            try {
                await LeadDatabase.resetReminderFlags(lead.id);
                // Update the lead object to reflect the reset
                lead.reminder_1hr_sent = 0;
                lead.reminder_24hr_sent = 0;
                lead.reminder_48hr_sent = 0;
            } catch (error) {
                console.error(`⚠️ Failed to reset reminder flags (non-critical):`, error.message);
            }
        }
        
        // Check if lead is already qualified
        if (lead.qualified === true || lead.status === 'qualified') {
            console.log(`💬 Lead is qualified - checking message type`);
            
            // FIRST: Check if this is a simple thank you response (handle these immediately)
            const lowerMessage = userMessage.toLowerCase().trim();
            const isThankYou = lowerMessage === 'thanks' || 
                               lowerMessage === 'thank you' || 
                               lowerMessage === 'thankyou' ||
                               lowerMessage === 'ty' ||
                               lowerMessage === 'thx' ||
                               lowerMessage === '👍' ||
                               lowerMessage === 'thanks!' ||
                               lowerMessage === 'thank you!' ||
                               lowerMessage === 'thank you.' ||
                               lowerMessage === 'thanks.';
            
            if (isThankYou) {
                console.log(`👋 Simple thank you detected - sending "You are very welcome" response`);
                const simpleResponse = "You are very welcome 😊";
                await sendSMS(lead.phone, simpleResponse);
                await LeadDatabase.createMessage(lead.id, 'assistant', simpleResponse);
                console.log(`✅ Simple "You are very welcome" sent`);
                
                // Mark post_qualification_response_sent as true so we don't send the long message later
                if (!lead.post_qualification_response_sent) {
                    await LeadDatabase.updateLead(lead.id, {
                        name: lead.name,
                        email: lead.email,
                        status: lead.status,
                        progress: lead.progress,
                        qualified: lead.qualified,
                        ai_paused: lead.ai_paused,
                        post_qualification_response_sent: true, // Mark as sent
                        answers: lead.answers,
                        qualifiedDate: lead.qualifiedDate,
                        returning_customer: lead.returning_customer || false,
                        times_qualified: lead.times_qualified || 0,
                        first_qualified_date: lead.first_qualified_date,
                        last_qualified_date: lead.last_qualified_date
                    });
                }
                return;
            }
            
            // Check if we already sent the post-qualification response
            if (lead.post_qualification_response_sent) {
                console.log(`🔇 Post-qualification response already sent - staying silent for non-thank-you message`);
                console.log(`📝 Customer message stored but no reply sent to avoid repetition`);
                return; // Complete silence for other messages
            }
            
            console.log(`📤 Sending post-qualification auto-response (FIRST TIME ONLY)`);
            
            // Send auto-response ONCE
            const autoResponse = "Thanks for your message! We will be in touch but if you have any further questions, feel free to give us a call during business hours (Mon-Fri 8am-5pm, Sat 10am-3pm). Tel:01606 272788";
            
            await sendSMS(lead.phone, autoResponse);
            
            // Store auto-response in database
            await LeadDatabase.createMessage(lead.id, 'assistant', autoResponse);
            
            // Mark as sent - will never send this message again
            await LeadDatabase.updateLead(lead.id, {
                name: lead.name,
                email: lead.email,
                status: lead.status,
                progress: lead.progress,
                qualified: lead.qualified,
                ai_paused: lead.ai_paused,
                post_qualification_response_sent: true, // Mark as sent
                answers: lead.answers,
                qualifiedDate: lead.qualifiedDate,
                returning_customer: lead.returning_customer || false,
                times_qualified: lead.times_qualified || 0,
                first_qualified_date: lead.first_qualified_date,
                last_qualified_date: lead.last_qualified_date
            });
            
            console.log(`✅ Post-qualification auto-response sent to ${lead.name} (${lead.phone}) - will not send again`);
            return;
        }
        
        // FIRST: Extract answers from user message BEFORE generating AI response
        console.log(`🔍 Extracting answers from message (multi-answer extraction enabled)...`);
        lead.answers = lead.answers || {};
        // Count only actual answers, not tracking fields
        const answeredCountBefore = Object.keys(lead.answers).filter(k => !k.startsWith('_')).length;
        
        console.log(`📊 Current state: ${answeredCountBefore} questions already answered`);
        console.log(`📋 Existing answers:`, JSON.stringify(lead.answers, null, 2));
        
        // AGGRESSIVELY extract answers for ALL unanswered questions from EVERY message
        // This ensures we collect what we can from the first message and all subsequent messages
        if (answeredCountBefore < CUSTOM_QUESTIONS.length && userMessage.trim().length > 0) {
            console.log(`🔍 AGGRESSIVE EXTRACTION: Scanning message for ALL possible answers...`);
            let newAnswersFound = 0;
            
            // Initialize questions_asked if needed
            if (!lead.answers._questions_asked) {
                lead.answers._questions_asked = {};
            }
            
            // Check each unanswered question
            for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                const questionKey = `question_${i + 1}`;
                
                // Skip if already answered
                if (lead.answers[questionKey]) {
                    console.log(`   ⏭️ Question ${i + 1} already answered, skipping`);
                    continue;
                }
                
                const question = CUSTOM_QUESTIONS[i];
                const possibleAnswers = question.possibleAnswers || '';
                
                // Try to extract answer for this question from the message
                const extractedAnswer = extractAnswerForQuestion(userMessage, possibleAnswers, i + 1);
                
                if (extractedAnswer) {
                    // Normalize answer to lowercase for consistent storage and comparison
                    const normalizedAnswer = typeof extractedAnswer === 'string' ? extractedAnswer.toLowerCase().trim() : extractedAnswer;
                    lead.answers[questionKey] = normalizedAnswer;
                    newAnswersFound++;
                    console.log(`   ✅ Found answer for Q${i + 1}: "${normalizedAnswer}"`);
                } else {
                    console.log(`   ❓ No match found for Q${i + 1} in this message`);
                }
            }
            
            // Update progress if any new answers were found
            if (newAnswersFound > 0) {
                // Count only actual answers, not tracking fields
                const newAnsweredCount = Object.keys(lead.answers).filter(k => !k.startsWith('_')).length;
                lead.progress = Math.round((newAnsweredCount / 4) * 100);
                lead.status = lead.progress === 100 ? 'qualified' : 'active';
                
                // Save to database
                await LeadDatabase.updateLead(lead.id, {
                    name: lead.name,
                    email: lead.email,
                    status: lead.status,
                    progress: lead.progress,
                    qualified: lead.qualified,
                    ai_paused: lead.ai_paused,
                    post_qualification_response_sent: lead.post_qualification_response_sent || false,
                    answers: lead.answers,
                    qualifiedDate: lead.qualifiedDate,
                    returning_customer: lead.returning_customer || false,
                    times_qualified: lead.times_qualified || 0,
                    first_qualified_date: lead.first_qualified_date,
                    last_qualified_date: lead.last_qualified_date
                });
                
                console.log(`✅ Extracted ${newAnswersFound} answer(s) from single message!`);
                console.log(`📈 Progress updated: ${newAnsweredCount}/4 questions (${lead.progress}%)`);
            } else {
                console.log(`❌ No valid answers extracted from message`);
            }
        }
        
        // Check if all questions are answered NOW (after storing answer)
        // Count only actual answers, not tracking fields
        const answeredCount = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
        console.log(`📊 Current progress: ${answeredCount}/4 questions answered`);
        console.log(`📋 Current answers:`, lead.answers);
        
        if (answeredCount >= 4 && !lead.qualified) {
            console.log(`🎉 All questions answered - qualifying lead`);
            
            // All questions answered - qualify lead (only send this message once)
            const qualificationMessage = `Thank you! I have all the information I need to help you, I will pass this on to a member of our team who will be in touch. 
If you have any questions in the meantime our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm. 🐴✨Tel:01606 272788`;

            await sendSMS(lead.phone, qualificationMessage);
            
            // Store qualification message in database
            await LeadDatabase.createMessage(lead.id, 'assistant', qualificationMessage);
            
            // Mark as qualified
            const qualifiedDate = new Date().toISOString();
            lead.qualified = true;
            lead.qualifiedDate = qualifiedDate;
            lead.status = 'qualified';
            lead.progress = 100;
            
            // Set first_qualified_date if this is their first time
            if (!lead.first_qualified_date) {
                lead.first_qualified_date = qualifiedDate;
            }
            
            // Always update last_qualified_date
            lead.last_qualified_date = qualifiedDate;
            
            // Update in database
            await LeadDatabase.updateLead(lead.id, {
                name: lead.name,
                email: lead.email,
                status: lead.status,
                progress: lead.progress,
                qualified: true,
                ai_paused: lead.ai_paused,
                post_qualification_response_sent: false, // First time qualifying, haven't sent post-qual response yet
                answers: lead.answers,
                qualifiedDate: lead.qualifiedDate,
                returning_customer: lead.returning_customer || false,
                times_qualified: lead.times_qualified || 0,
                first_qualified_date: lead.first_qualified_date,
                last_qualified_date: lead.last_qualified_date
            });
            
            console.log(`🎉 Lead qualified: ${lead.name} (${lead.phone})`);
            if (lead.returning_customer) {
                console.log(`   🔄 Returning customer - qualified ${lead.times_qualified} time(s) total`);
            }
            
            // 🔥 SEND TO CRM WEBHOOK
            // Reload lead from database to ensure all data is current and properly structured
            try {
                const qualifiedLead = await LeadDatabase.getLeadById(lead.id);
                await sendToCRMWebhook(qualifiedLead, 'lead_qualified', {
                    qualificationMethod: 'auto_conversation',
                    triggeredBy: 'incoming_sms'
                });
            } catch (error) {
                console.error('⚠️ Failed to send webhook (non-critical):', error.message);
            }
            
            return;
        }
        
        // Double-check if all questions are now answered (safety check)
        const currentAnsweredCount = Object.keys(lead.answers || {}).length;
        console.log(`🔍 Safety Check - Current answers:`, lead.answers);
        console.log(`🔍 Safety Check - Total answered: ${currentAnsweredCount}/4`);
        
        if (currentAnsweredCount >= 4) {
            console.log(`⚠️ All questions now answered - skipping AI response generation`);
            return; // Exit early - qualification message already sent above
        }
        
        console.log(`🤖 Generating AI response...`);
        console.log(`📊 Current state for AI context:`);
        console.log(`   - Before extraction: ${answeredCountBefore} answers`);
        console.log(`   - After extraction: ${currentAnsweredCount} answers`);
        console.log(`   - Just extracted: ${currentAnsweredCount - answeredCountBefore} answers`);
        console.log(`   - Questions remaining: ${4 - currentAnsweredCount}`);
        console.log(`   - Current answers object:`, JSON.stringify(lead.answers, null, 2));
        
        // Generate AI response using Assistant
        // Count only actual answers, not tracking fields
        const actualAnswersBefore = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
        const answersJustExtracted = actualAnswersBefore - answeredCountBefore;
        const aiResponse = await generateAIResponseWithAssistant(lead, userMessage, answersJustExtracted);
        
        if (aiResponse) {
            console.log(`📤 Sending AI response: "${aiResponse}"`);
            
            // CRITICAL: Before sending, check if this response contains a question and mark it as asked
            // Find which question is being asked in the response
            for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
                const q = CUSTOM_QUESTIONS[i];
                const qText = typeof q === 'object' ? q.question : q;
                const questionKey = `question_${i + 1}`;
                
                // If this question text appears in the response and hasn't been asked yet, mark it as asked
                if (aiResponse.includes(qText) && (!lead.answers._questions_asked || !lead.answers._questions_asked[questionKey])) {
                    if (!lead.answers._questions_asked) {
                        lead.answers._questions_asked = {};
                    }
                    lead.answers._questions_asked[questionKey] = true;
                    console.log(`   ✅ Marked Q${i + 1} as asked in AI response - will NEVER ask again`);
                }
            }
            
            await sendSMS(lead.phone, aiResponse);
            
            // Store AI response in database
            LeadDatabase.createMessage(lead.id, 'assistant', aiResponse);
            
            // Save the "asked" flags to database
            await LeadDatabase.updateLead(lead.id, {
                name: lead.name,
                email: lead.email,
                status: lead.status,
                progress: lead.progress,
                qualified: lead.qualified,
                ai_paused: lead.ai_paused,
                post_qualification_response_sent: lead.post_qualification_response_sent,
                answers: lead.answers,
                qualifiedDate: lead.qualifiedDate,
                returning_customer: lead.returning_customer || false,
                times_qualified: lead.times_qualified || 0,
                first_qualified_date: lead.first_qualified_date,
                last_qualified_date: lead.last_qualified_date
            });
            
            console.log(`✅ AI response sent to ${lead.name} (${lead.phone}): "${aiResponse}"`);
        } else {
            console.log(`❌ No AI response generated`);
        }
    } catch (error) {
        console.error('❌ Error processing AI response:', error);
    }
}

// Generate AI response using OpenAI Assistant
async function generateAIResponseWithAssistant(lead, userMessage, answersExtracted = 0) {
    try {
        console.log(`🔍 Checking AI configuration...`);
        console.log(`🤖 OpenAI Client:`, openaiClient ? 'Available' : 'Not available');
        console.log(`🆔 Assistant ID:`, assistantId ? assistantId : 'Not set');
        
        if (!openaiClient || !assistantId) {
            console.log('⚠️ OpenAI Assistant not configured - using fallback response');
            return await generateFallbackResponse(lead, userMessage);
        }
        
        // Get conversation history to avoid repeating responses
        const messageHistory = await LeadDatabase.getConversationHistory(lead.id);
        const recentMessages = messageHistory.slice(-10); // Last 10 messages for context
        
        console.log(`📜 Loaded ${recentMessages.length} recent messages for AI context`);
        
        // Build context about what information we need
        // Count only actual answers, not tracking fields
        const answeredCount = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
        const unansweredQuestions = [];
        const gatheredInfo = [];
        
        console.log(`📋 Building AI context with current answers:`, JSON.stringify(lead.answers, null, 2));
        
        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
            const questionKey = `question_${i + 1}`;
            const q = CUSTOM_QUESTIONS[i];
            const questionText = typeof q === 'object' ? q.question : q;
            
            if (lead.answers && lead.answers[questionKey]) {
                gatheredInfo.push(`${questionText}: ${lead.answers[questionKey]}`);
                console.log(`   ✅ Question ${i + 1} already answered: ${lead.answers[questionKey]}`);
            } else {
                unansweredQuestions.push(q);
                console.log(`   ❓ Question ${i + 1} still needs answer: ${questionText}`);
            }
        }
        
        // Build instructions for the Assistant
        const questionsText = CUSTOM_QUESTIONS.map((q, i) => {
            const questionText = typeof q === 'object' ? q.question : q;
            const possibleAnswers = typeof q === 'object' && q.possibleAnswers ? q.possibleAnswers : 'Any response';
            return `${i + 1}. ${questionText}\n   Possible answers: ${possibleAnswers}`;
        }).join('\n\n');
        
        // Find the FIRST unanswered AND unasked question (CRITICAL: Never ask same question twice)
        let nextQuestionIndex = -1;
        let nextQuestion = null;
        
        // Initialize questions_asked tracking if it doesn't exist
        if (!lead.answers) {
            lead.answers = {};
        }
        if (!lead.answers._questions_asked) {
            lead.answers._questions_asked = {};
        }
        
        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
            const questionKey = `question_${i + 1}`;
            const askedKey = `question_${i + 1}`;
            
            // CRITICAL: Skip if question has already been asked (even if not answered)
            if (lead.answers._questions_asked && lead.answers._questions_asked[askedKey]) {
                console.log(`   🚫 Q${i + 1} already asked - SKIPPING (will never ask again)`);
                continue;
            }
            
            // If not answered, this is the next question to ask
            if (!lead.answers[questionKey]) {
                nextQuestionIndex = i + 1;
                nextQuestion = CUSTOM_QUESTIONS[i];
                console.log(`   ✅ Q${i + 1} is unanswered and unasked - SELECTING`);
                break;
            }
        }
        
        const questionText = nextQuestion ? (typeof nextQuestion === 'object' ? nextQuestion.question : nextQuestion) : '';
        const nextQuestionAvailable = nextQuestionIndex > 0;
        
        console.log(`📋 Next unanswered question: Q${nextQuestionIndex} - "${questionText}"`);
        
        // Format conversation history for AI context
        const historyText = recentMessages.length > 0 
            ? recentMessages.map(m => `${m.sender}: ${m.content}`).join('\n')
            : 'No previous messages';
        
        // Build list of what we already have
        const alreadyAnsweredText = gatheredInfo.length > 0 
            ? `\nALREADY ANSWERED (DO NOT ASK THESE AGAIN):\n${gatheredInfo.map((info, idx) => `${idx + 1}. ${info}`).join('\n')}`
            : '\nALREADY ANSWERED: None yet';
        
        let contextInstructions = `MODE: QUALIFICATION
CUSTOMER_NAME: ${lead.name}
ANSWERS_JUST_EXTRACTED: ${answersExtracted}
TOTAL_QUESTIONS_ANSWERED: ${answeredCount}
QUESTIONS_REMAINING: ${unansweredQuestions.length}
NEXT_QUESTION_INDEX: ${nextQuestionIndex}
NEXT_QUESTION_TEXT: ${questionText}
${alreadyAnsweredText}

CUSTOMER_MESSAGE: "${userMessage}"

CONVERSATION HISTORY (DO NOT REPEAT these exact phrases):
${historyText}

INSTRUCTIONS: 
1. Review ALREADY ANSWERED section - NEVER ask about these topics again
2. If ANSWERS_JUST_EXTRACTED > 0, acknowledge what was captured (e.g., "Great! I've got your details.")
3. If ANSWERS_JUST_EXTRACTED > 1, acknowledge multiple answers (e.g., "Perfect! I have those details.")
4. ONLY ask the NEXT_QUESTION_TEXT - do NOT ask about already answered questions
5. NEVER repeat the same acknowledgment - vary your responses naturally
6. Check the CONVERSATION HISTORY and avoid repeating phrases you've already used
7. Be conversational and natural - you're having a dialogue, not reading a script
8. Flow smoothly from acknowledgment to next question`;

        // Create a thread for this conversation
        const thread = await openaiClient.beta.threads.create();
        
        // Add the context and user message to thread
        await openaiClient.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: contextInstructions
        });
        
        console.log(`📋 Context sent to Assistant:`);
        console.log(`   ✅ Already answered: ${answeredCount}/4 questions`);
        console.log(`   ❓ Still need: ${unansweredQuestions.length} answers`);
        if (gatheredInfo.length > 0) {
            console.log(`   📊 Gathered info:`, gatheredInfo);
        }
        if (unansweredQuestions.length > 0) {
            console.log(`   🎯 Next to gather:`, unansweredQuestions);
        }
        
        // Run the assistant
        const run = await openaiClient.beta.threads.runs.create(thread.id, {
            assistant_id: assistantId
        });
        
        // Wait for completion with timeout
        console.log(`⏳ Waiting for Assistant response...`);
        console.log(`⏳ Initial 3-second delay to allow assistant to start...`);
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second initial delay
        
        let runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 30; // 30 seconds timeout
        
        while (runStatus.status !== 'completed' && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
            
            console.log(`⏳ Attempt ${attempts}/${maxAttempts} - Status: ${runStatus.status}`);
            
            if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
                console.log(`❌ Assistant run failed with status: ${runStatus.status}`);
                console.log(`❌ Last error:`, JSON.stringify(runStatus.last_error, null, 2));
                console.log(`❌ Full run status:`, JSON.stringify(runStatus, null, 2));
                throw new Error(`Assistant run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
            }
        }
        
        if (attempts >= maxAttempts) {
            console.log(`⏰ Assistant response timeout after ${maxAttempts} seconds`);
            throw new Error('Assistant response timeout');
        }
        
        console.log(`✅ Assistant completed in ${attempts} seconds`);

        
        // Get the assistant's response
        const messages = await openaiClient.beta.threads.messages.list(thread.id);
        const assistantMessage = messages.data[0];
        
        if (assistantMessage && assistantMessage.content[0].type === 'text') {
            const response = assistantMessage.content[0].text.value;
            
            console.log(`✅ Assistant response received: "${response}"`);
            
            // Note: Answer extraction now happens BEFORE AI response generation (line 654-671)
            // This ensures the AI sees the stored answer in its context and doesn't ask again
            
            return response;
        }
        
        console.log(`❌ No valid assistant message found`);
        return await generateFallbackResponse(lead, userMessage);
    } catch (error) {
        console.error('❌ Error generating AI response with Assistant:', error);
        console.error('❌ Error details:', error.message);
        console.error('❌ Falling back to basic response system');
        return await generateFallbackResponse(lead, userMessage);
    }
}

// Fallback response when Assistant is not available
async function generateFallbackResponse(lead, userMessage) {
    console.log(`🔄 Using fallback response system`);
    // Count only actual answers, not tracking fields
    const answeredCount = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
    
    console.log(`📊 Lead progress: ${answeredCount}/${CUSTOM_QUESTIONS.length} questions answered`);
    console.log(`📝 Custom questions:`, CUSTOM_QUESTIONS);
    console.log(`💬 User message length: ${userMessage.length} characters`);
    
    // Note: Answer storage happens in processAIResponse() before this function is called
    // Do NOT store answers here to avoid duplicate storage
    
    // Find first unanswered AND unasked question
    if (!lead.answers) {
        lead.answers = {};
    }
    if (!lead.answers._questions_asked) {
        lead.answers._questions_asked = {};
    }
    
    let nextQuestionIndex = -1;
    let nextQuestion = null;
    
    for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
        const questionKey = `question_${i + 1}`;
        const askedKey = `question_${i + 1}`;
        
        // CRITICAL: Skip if question has already been asked
        if (lead.answers._questions_asked && lead.answers._questions_asked[askedKey]) {
            continue;
        }
        
        // If not answered, this is the next question to ask
        if (!lead.answers[questionKey]) {
            nextQuestionIndex = i + 1;
            nextQuestion = CUSTOM_QUESTIONS[i];
            break;
        }
    }
    
    if (nextQuestion && nextQuestionIndex > 0) {
        const questionText = typeof nextQuestion === 'object' ? nextQuestion.question : nextQuestion;
        console.log(`❓ Asking question ${nextQuestionIndex}: ${questionText}`);
        
        // CRITICAL: Mark this question as asked
        if (!lead.answers._questions_asked) {
            lead.answers._questions_asked = {};
        }
        lead.answers._questions_asked[`question_${nextQuestionIndex}`] = true;
        console.log(`   ✅ Marked Q${nextQuestionIndex} as asked - will NEVER ask again`);
        
        // Ask the next question with acknowledgment
        const acknowledgments = [
            "Got it! ",
            "Perfect! ",
            "Thanks! ",
            "Excellent! ",
            "Great! "
        ];
        const randomAck = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
        
        const response = `${randomAck}${questionText}`;
        console.log(`📤 Fallback response: ${response}`);
        return response;
    }
    
    const response = "Thank you for your response! I'll have our team contact you soon.";
    console.log(`📤 Default response: ${response}`);
    return response;
}

// Generate conversational response for qualified leads (using Chat Completions API for reliability)
async function generateQualifiedChatResponse(lead, userMessage) {
    try {
        console.log(`💬 Generating qualified chat response...`);
        console.log(`   OpenAI Client: ${openaiClient ? 'Available' : 'NOT AVAILABLE'}`);
        
        if (!openaiClient) {
            console.log('⚠️ OpenAI client not configured - using simple response');
            return "You're welcome! If you have any other questions, our team will be happy to help when they contact you.";
        }
        
        // Build system prompt for conversational AI
        const systemPrompt = `You are ${ASSISTANT_NAME}, a friendly AI assistant from CSGB Cheshire Stables, a premium equine stable manufacturing company based in Cheshire, England.

COMPANY INFO:
- We build horse stables, American barns, field shelters, and equine buildings
- We're open Monday-Friday 8am-5pm, Saturday 10am-3pm
- We serve customers across the UK and internationally
- We offer bespoke designs, quality materials, and professional installation

CUSTOMER STATUS:
This customer has already completed qualification and been told our team will contact them within 24 hours.

YOUR ROLE:
- Answer their questions directly and helpfully
- Provide specific information about our services, opening hours, products
- Be conversational and natural
- Keep responses brief (under 160 characters when possible for SMS)
- Use British English
- Be warm and professional
- Don't repeat qualification information unless asked

EXAMPLE RESPONSES:
- "Are you open today?" → "Yes! We're open Monday-Friday 8am-5pm and Saturday 10am-3pm. How can I help?"
- "What do you build?" → "We specialise in horse stables, American barns, field shelters and custom equine buildings. All bespoke designs with quality materials."
- "Thank you" → "You're very welcome! Our team will be in touch soon to discuss your project."

Their requirements (for context):
${Object.entries(lead.answers || {}).map(([key, value], i) => {
    const q = CUSTOM_QUESTIONS[i];
    const questionText = typeof q === 'object' ? q.question : q;
    return `- ${questionText}: ${value}`;
}).join('\n')}`;

        // Use Chat Completions API (more reliable than Assistant API for simple responses)
        console.log(`📋 Sending chat request to OpenAI...`);
        const completion = await openaiClient.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 200,
            temperature: 0.8
        });
        
        const response = completion.choices[0].message.content.trim();
        console.log(`✅ Chat response received: "${response}"`);
        return response;
        
    } catch (error) {
        console.error('❌ Error generating qualified chat response:', error);
        console.error('❌ Error details:', error.message);
        console.log('⚠️ Falling back to simple response due to error above');
        return "You're welcome! If you have any other questions, our team will be happy to help when they contact you.";
    }
}

// Generate conversational response for qualified leads using Assistant API
async function generateQualifiedChatResponseWithAssistant(lead, userMessage) {
    try {
        console.log(`💬 Generating qualified chat response with Assistant...`);
        console.log(`   OpenAI Client: ${openaiClient ? 'Available' : 'NOT AVAILABLE'}`);
        console.log(`   Assistant ID: ${assistantId ? assistantId : 'NOT SET'}`);
        
        if (!openaiClient || !assistantId) {
            console.log('⚠️ OpenAI Assistant not configured - using simple response');
            return "You're welcome! If you have any other questions, our team will be happy to help when they contact you.";
        }
        
        // Build context for post-qualification chat using Assistant
        const chatInstructions = `CUSTOMER STATUS: This customer (${lead.name}) has already completed the qualification process. All 4 qualification questions have been answered and they've been informed that our team will contact them within 24 hours.

YOUR ROLE NOW: Answer any questions they have about our services, opening hours, products, or anything else. Be helpful, conversational, and natural. This is FREE CHAT MODE - not qualification mode.

THEIR QUALIFICATION INFO (for context):
${Object.entries(lead.answers || {}).map(([key, value], i) => {
    const q = CUSTOM_QUESTIONS[i];
    const questionText = typeof q === 'object' ? q.question : q;
    return `- ${questionText}: ${value}`;
}).join('\n')}

Customer's message: "${userMessage}"

Respond naturally and helpfully. Answer their specific questions about our business, services, opening hours, etc. Be conversational and warm.`;

        // Create a thread for this conversation
        const thread = await openaiClient.beta.threads.create();
        
        // Add the message to thread
        await openaiClient.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: chatInstructions
        });
        
        console.log(`📋 Chat context sent to Assistant for qualified lead`);
        
        // Run the assistant
        const run = await openaiClient.beta.threads.runs.create(thread.id, {
            assistant_id: assistantId
        });
        
        // Wait for completion with timeout
        console.log(`⏳ Waiting for Assistant chat response...`);
        console.log(`⏳ Initial 3-second delay to allow assistant to start...`);
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second initial delay
        
        let runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 30;
        
        while (runStatus.status !== 'completed' && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
            
            if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
                console.log(`❌ Assistant run failed with status: ${runStatus.status}`);
                console.log(`❌ Last error:`, JSON.stringify(runStatus.last_error, null, 2));
                console.log(`❌ Full run status:`, JSON.stringify(runStatus, null, 2));
                throw new Error(`Assistant run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
            }
        }
        
        if (attempts >= maxAttempts) {
            throw new Error('Assistant response timeout');
        }
        
        console.log(`✅ Assistant chat completed in ${attempts} seconds`);
        
        // Get the assistant's response
        const messages = await openaiClient.beta.threads.messages.list(thread.id);
        const assistantMessage = messages.data[0];
        
        if (assistantMessage && assistantMessage.content[0].type === 'text') {
            const response = assistantMessage.content[0].text.value;
            console.log(`✅ Chat response received: "${response}"`);
            return response;
        }
        
        console.log(`❌ No valid assistant message found`);
        return "You're welcome! Our team will be in touch with you soon. Feel free to ask if you have any other questions!";
    } catch (error) {
        console.error('❌ Error generating qualified chat response with Assistant:', error);
        console.error('❌ Error details:', error.message);
        console.log('⚠️ Falling back to simple response due to error above');
        return "You're welcome! If you have any other questions, our team will be happy to help when they contact you.";
    }
}

// Extract answers from conversation using AI
async function extractAnswersFromConversation(lead, userMessage, aiResponse) {
    try {
        if (!openaiClient) {
            console.log('⚠️ Cannot extract answers - OpenAI client not available');
            return;
        }
        
        console.log(`🔍 Extracting answers from conversation...`);
        
        // Build context about what we're looking for
        const unansweredQuestions = [];
        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
            const questionKey = `question_${i + 1}`;
            if (!lead.answers || !lead.answers[questionKey]) {
                const q = CUSTOM_QUESTIONS[i];
                const questionText = typeof q === 'object' ? q.question : q;
                const possibleAnswers = typeof q === 'object' ? q.possibleAnswers : '';
                
                unansweredQuestions.push({
                    number: i + 1,
                    question: questionText,
                    possibleAnswers: possibleAnswers,
                    key: questionKey
                });
            }
        }
        
        if (unansweredQuestions.length === 0) {
            console.log('✅ All questions already answered');
            return;
        }
        
        // Use AI to extract answers from the user's message
        const extractionPrompt = `Analyze this customer message and determine if it contains answers to any of these questions:

QUESTIONS TO FIND ANSWERS FOR:
${unansweredQuestions.map(q => `${q.number}. ${q.question}${q.possibleAnswers ? '\n   Possible answers include: ' + q.possibleAnswers : ''}`).join('\n\n')}

CUSTOMER MESSAGE: "${userMessage}"

IMPORTANT: 
- Accept ANY response as an answer. Even "yes", "no", "maybe", or short responses count as valid answers.
- If the customer's response matches or is similar to ANY of the possible answers, mark it as answered.
- Be very lenient - any response that could relate to the question counts as an answer.

For each question that has an answer in the customer's message, respond with:
ANSWER_${q.number}: [the customer's exact response]

If the customer's message doesn't answer a question, don't include it.
Accept the first answer given - don't wait for more details.`;

        const completion = await openaiClient.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are an expert at extracting structured information from customer conversations.' },
                { role: 'user', content: extractionPrompt }
            ],
            max_tokens: 200,
            temperature: 0.3
        });
        
        const extractionResult = completion.choices[0].message.content;
        console.log(`📝 Extraction result: ${extractionResult}`);
        
        // Also do a simple keyword match as a fallback
        let answersExtracted = false;
        
        // Parse the extraction result
        unansweredQuestions.forEach(q => {
            const answerMatch = extractionResult.match(new RegExp(`ANSWER_${q.number}:\\s*(.+?)(?:\\n|$)`, 'i'));
            if (answerMatch && answerMatch[1]) {
                const answer = answerMatch[1].trim();
                if (answer && answer !== 'N/A' && answer !== 'Not mentioned' && answer !== 'None') {
                    lead.answers = lead.answers || {};
                    lead.answers[q.key] = answer;
                    console.log(`✅ Extracted answer for question ${q.number}: ${answer}`);
                    answersExtracted = true;
                }
            }
        });
        
        // If AI extraction failed, do simple matching for first unanswered question
        if (!answersExtracted && unansweredQuestions.length > 0) {
            console.log(`🔍 AI extraction didn't find answers - trying simple matching...`);
            const firstUnanswered = unansweredQuestions[0];
            
            // If user message is meaningful (more than just whitespace), accept it as answer
            if (userMessage && userMessage.trim().length > 0) {
                lead.answers = lead.answers || {};
                lead.answers[firstUnanswered.key] = userMessage;
                console.log(`✅ Simple match: Stored "${userMessage}" as answer for question ${firstUnanswered.number}`);
                answersExtracted = true;
            }
        }
        
        // Update progress
        // Count only actual answers, not tracking fields
        const answeredCount = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
        lead.progress = Math.round((answeredCount / 4) * 100);
        lead.status = lead.progress === 100 ? 'qualified' : 'active';
        console.log(`📈 Lead progress updated: ${answeredCount}/4 questions answered (${lead.progress}%)`);
        
    } catch (error) {
        console.error('Error extracting answers:', error);
    }
}

// Update lead progress based on user response (legacy fallback)
async function updateLeadProgress(lead, userMessage) {
    try {
        // Count only actual answers, not tracking fields
        const answeredCount = Object.keys(lead.answers || {}).filter(k => !k.startsWith('_')).length;
        
        if (answeredCount < CUSTOM_QUESTIONS.length && userMessage.length > 5) {
            // Store the answer
            const questionKey = `question_${answeredCount + 1}`;
            lead.answers = lead.answers || {};
            // Normalize answer to lowercase for consistent storage and comparison
            lead.answers[questionKey] = typeof userMessage === 'string' ? userMessage.toLowerCase().trim() : userMessage;
            
            // Update progress
            const newAnsweredCount = Object.keys(lead.answers).length;
            lead.progress = Math.round((newAnsweredCount / 4) * 100);
            lead.status = lead.progress === 100 ? 'qualified' : 'active';
        }
    } catch (error) {
        console.error('Error updating lead progress:', error);
    }
}

// Send SMS
async function sendSMS(to, message) {
    try {
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
            console.log('⚠️ Twilio credentials not configured - SMS not sent');
            return;
        }
        
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.messages.create({
            body: message,
            from: process.env.TWILIO_FROM_NUMBER,
            to: to
        });
        
        console.log(`📤 SMS sent to ${to}: "${message}"`);
    } catch (error) {
        console.error('Error sending SMS:', error);
    }
}

// ============================================================================
// REMINDER SYSTEM FUNCTIONS
// ============================================================================

// Helper: Find first unanswered question for a lead
function findFirstUnansweredQuestion(lead) {
    // Initialize questions_asked tracking if it doesn't exist
    if (!lead.answers) {
        lead.answers = {};
    }
    if (!lead.answers._questions_asked) {
        lead.answers._questions_asked = {};
    }
    
    for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
        const questionKey = `question_${i + 1}`;
        const askedKey = `question_${i + 1}`;
        
        // CRITICAL: Never ask a question that has already been asked, even if not answered
        if (lead.answers._questions_asked && lead.answers._questions_asked[askedKey]) {
            console.log(`   🚫 Q${i + 1} already asked - SKIPPING (will never ask again)`);
            continue;
        }
        
        // If not answered, this is the next question to ask
        if (!lead.answers[questionKey]) {
            const q = CUSTOM_QUESTIONS[i];
            console.log(`   ✅ Q${i + 1} is unanswered and has not been asked yet - SELECTING`);
            return typeof q === 'object' ? q.question : q;
        }
    }
    
    // All questions answered or all asked - return null to indicate no more questions
    console.log(`   ⚠️ All questions have been asked or answered - no more questions available`);
    return null;
}

// Send 1 hour reminder
async function send1HourReminder(lead) {
    try {
        const nextQuestion = findFirstUnansweredQuestion(lead);
        const message = `Hi ${lead.name}, just following up - ${nextQuestion}`;
        
        await sendSMS(lead.phone, message);
        await LeadDatabase.createMessage(lead.id, 'assistant', message);
        await LeadDatabase.updateReminderSent(lead.id, '1hr');
        
        console.log(`🔔 1hr reminder sent to ${lead.name} (${lead.phone})`);
    } catch (error) {
        console.error(`❌ Error sending 1hr reminder to lead ${lead.id}:`, error);
    }
}

// Send 24 hour reminder
async function send24HourReminder(lead) {
    try {
        const nextQuestion = findFirstUnansweredQuestion(lead);
        const message = `Hi ${lead.name}, I wanted to check back with you - ${nextQuestion}`;
        
        await sendSMS(lead.phone, message);
        await LeadDatabase.createMessage(lead.id, 'assistant', message);
        await LeadDatabase.updateReminderSent(lead.id, '24hr');
        
        console.log(`🔔 24hr reminder sent to ${lead.name} (${lead.phone})`);
    } catch (error) {
        console.error(`❌ Error sending 24hr reminder to lead ${lead.id}:`, error);
    }
}

// Send 48 hour final reminder
async function send48HourReminder(lead) {
    try {
        const message = `Hi ${lead.name}, Sorry to bother you again, are you still interested in getting a quote for your building? Reply YES to continue or NO to end this chat.`;
        
        await sendSMS(lead.phone, message);
        await LeadDatabase.createMessage(lead.id, 'assistant', message);
        await LeadDatabase.updateReminderSent(lead.id, '48hr');
        
        console.log(`🔔 48hr final reminder sent to ${lead.name} (${lead.phone})`);
    } catch (error) {
        console.error(`❌ Error sending 48hr reminder to lead ${lead.id}:`, error);
    }
}

// Check and send reminders to leads
async function checkAndSendReminders() {
    try {
        const now = new Date();
        const leads = await LeadDatabase.getAllLeads();
        
        const divisor = 1000 * 60; // ms to minutes
        
        console.log(`🔔 Checking ${leads.length} leads for reminders...`);
        
        for (const lead of leads) {
            // Skip if qualified, paused, or closed
            if (lead.qualified || lead.ai_paused || lead.status === 'closed') continue;
            
            // Skip if Q1 hasn't been answered yet (reminders only start after first response)
            if (!lead.answers || !lead.answers.question_1) {
                continue; // No reminders until Q1 is answered
            }
            
            // Skip if no last customer message time
            if (!lead.last_customer_message_time) continue;
            
            // Determine the time since last customer message (in minutes)
            const lastMessageTime = new Date(lead.last_customer_message_time);
            const timeSinceLastMessage = (now - lastMessageTime) / divisor;
            
            // First reminder
            if (timeSinceLastMessage >= REMINDER_INTERVALS.first && !lead.reminder_1hr_sent) {
                console.log(`⏰ Sending first reminder to ${lead.name} (last message ${timeSinceLastMessage.toFixed(1)} minutes ago)`);
                await send1HourReminder(lead);
            }
            
            // Second reminder
            if (timeSinceLastMessage >= REMINDER_INTERVALS.second && !lead.reminder_24hr_sent) {
                console.log(`⏰ Sending second reminder to ${lead.name} (last message ${timeSinceLastMessage.toFixed(1)} minutes ago)`);
                await send24HourReminder(lead);
            }
            
            // Final reminder
            if (timeSinceLastMessage >= REMINDER_INTERVALS.final && !lead.reminder_48hr_sent) {
                console.log(`⏰ Sending final reminder to ${lead.name} (last message ${timeSinceLastMessage.toFixed(1)} minutes ago)`);
                await send48HourReminder(lead);
            }
        }
        
        console.log(`✅ Reminder check complete`);
    } catch (error) {
        console.error('❌ Error checking reminders:', error);
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

// Utility functions
function normalizePhoneNumber(phone) {
    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');
    
    console.log(`📞 Normalizing phone: "${phone}" -> digits: "${digits}"`);
    
    // Handle UK numbers
    if (digits.startsWith('44')) {
        // Already has country code (44)
        return '+' + digits;
    } else if (digits.startsWith('0') && digits.length === 11) {
        // UK number starting with 0 (e.g., 07809505864)
        return '+44' + digits.substring(1);
    } else if (digits.length === 10 && digits.startsWith('7')) {
        // UK mobile without leading 0 (e.g., 7809505864)
        return '+44' + digits;
    }
    
    // Handle US numbers
    if (digits.length === 10) {
        return '+1' + digits;
    }
    
    // Handle numbers that already have country code
    if (digits.length >= 10) {
        return '+' + digits;
    }
    
    // Fallback: add + if it doesn't start with +
    if (!phone.startsWith('+')) {
        return '+' + digits;
    }
    
    return phone;
}

// Initialize database
async function startServer() {
    try {
        // Select database at runtime
        if (isPostgreSQL) {
            const { LeadDatabase: PGLeadDatabase, initializeDatabase } = require('./database-pg');
            LeadDatabase = PGLeadDatabase;
            await initializeDatabase();
            console.log('✅ PostgreSQL database initialized');
        } else {
            const { LeadDatabase: SQLiteLeadDatabase, initializeDatabase } = require('./database');
            LeadDatabase = SQLiteLeadDatabase;
            // Initialize SQLite database
            initializeDatabase();
            console.log('✅ SQLite database initialized');
        }
        
        // Load settings from database after database is initialized
        await loadSettingsFromDatabase();
        
        // Initialize production database
        try {
            console.log('🔧 Initializing production database...');
            await initializeProductionDatabase();
            console.log('✅ Production database initialized');
            
            // Create default admin user if none exists
            console.log('🔧 Checking for default admin user...');
            const adminCreated = await createDefaultAdmin();
            if (adminCreated) {
                console.log('✅ Default admin user created successfully');
            }
        } catch (error) {
            console.error('❌ Error initializing production database:', error);
            console.error('   Error details:', error.message);
            console.error('   Stack:', error.stack);
        }
        
        // Start reminder checker (checkInterval is in minutes)
        const checkIntervalMs = REMINDER_INTERVALS.checkInterval * 60 * 1000;
        
        setInterval(async () => {
            console.log('🔔 Checking for leads needing reminders...');
            await checkAndSendReminders();
        }, checkIntervalMs);
        
        console.log(`🔔 Reminder service started (checks every ${REMINDER_INTERVALS.checkInterval} minutes)`);
        console.log(`   First reminder: ${REMINDER_INTERVALS.first} minutes`);
        console.log(`   Second reminder: ${REMINDER_INTERVALS.second} minutes`);
        console.log(`   Final reminder: ${REMINDER_INTERVALS.final} minutes`);
        
        // Start midnight auto-clock-out scheduler
        function scheduleMidnightAutoClockOut() {
            const now = new Date();
            const midnight = new Date();
            midnight.setHours(24, 0, 0, 0); // Next midnight
            
            const msUntilMidnight = midnight.getTime() - now.getTime();
            
            console.log(`🕛 Midnight auto-clock-out scheduled. Next run in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);
            
            setTimeout(async () => {
                try {
                    console.log('🕛 Running scheduled midnight auto-clock-out...');
                    await ProductionDatabase.autoClockOutAllAtMidnight();
                } catch (error) {
                    console.error('❌ Error in midnight auto-clock-out:', error);
                }
                
                // Schedule next run (24 hours from now)
                setInterval(async () => {
                    try {
                        console.log('🕛 Running scheduled midnight auto-clock-out...');
                        await ProductionDatabase.autoClockOutAllAtMidnight();
                    } catch (error) {
                        console.error('❌ Error in midnight auto-clock-out:', error);
                    }
                }, 24 * 60 * 60 * 1000); // 24 hours
            }, msUntilMidnight);
        }
        
        // Only start if ProductionDatabase is available
        if (typeof ProductionDatabase !== 'undefined' && ProductionDatabase.autoClockOutAllAtMidnight) {
            scheduleMidnightAutoClockOut();
        }
        
        // Start the server on 0.0.0.0 to accept external connections (required for Railway)
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Lead Qualification System v5.1.0 running on port ${PORT}`);
            console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook/sms`);
            console.log(`🌐 Web Interface: http://localhost:${PORT}`);
            console.log(`🎯 Natural AI conversation system ready!`);
            console.log(`\n📊 Configuration Summary:`);
            console.log(`   OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Not set'}`);
            console.log(`   Assistant ID: ${process.env.OPENAI_ASSISTANT_ID ? `✅ ${process.env.OPENAI_ASSISTANT_ID}` : '❌ Not set'}`);
            console.log(`   Twilio Account SID: ${process.env.TWILIO_ACCOUNT_SID ? '✅ Set' : '❌ Not set'}`);
            console.log(`   Twilio From Number: ${process.env.TWILIO_FROM_NUMBER || '❌ Not set'}`);
            console.log(`\n🎯 Custom Questions:`);
            CUSTOM_QUESTIONS.forEach((q, i) => {
                const questionText = typeof q === 'object' ? q.question : q;
                const possibleAnswers = typeof q === 'object' && q.possibleAnswers ? ` (Options: ${q.possibleAnswers})` : '';
                console.log(`   ${i + 1}. ${questionText}${possibleAnswers}`);
            });
            console.log('\n');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer();