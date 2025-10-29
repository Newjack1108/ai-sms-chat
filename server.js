// Lead Qualification System - Professional CRM Interface v5.6.0 with Database Persistence
// Forcing rebuild with Node 20
const express = require('express');
const path = require('path');
const cors = require('cors');
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database is now persistent - no more in-memory storage
console.log('💾 Using SQLite database for persistent storage');

// Default custom questions for lead qualification (can be updated via API)
let CUSTOM_QUESTIONS = [
    {
        question: "What type of building do you require?",
        possibleAnswers: "Double, Single, Stables, Stable, Field shelter, Barn, 24ft, 12ft, 36ft, tack room"
    },
    {
        question: "Does your building need to be mobile?",
        possibleAnswers: "skids, mobile, towable, yes, moveable, movable, portable, transportable, steel skid, wooden skids, on skids, no, static, fixed, permanent, stationary"
    },
    {
        question: "How soon do you need the building?",
        possibleAnswers: "ASAP, asap, urgent, urgently, soon, soonest, week, weeks, 1 week, a week, month, months, 1 month, a month, next year, day, days, today, tomorrow, tbc, TBC, don't mind, anytime, not fussed, quickly, fast, immediately"
    },
    {
        question: "Did you supply the postcode where the building is to be installed?",
        possibleAnswers: "any postcode format (lowercase and uppercase), collection, collect, pickup, pick up, ill get it, i'll get it, i will get it, getting it, ill collect, i'll collect, i will collect"
    }
];

// Assistant name (can be updated via API)
let ASSISTANT_NAME = "William";

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
    } catch (error) {
        console.error('❌ Error loading settings from database:', error);
        // Continue with defaults if database fails
    }
}

// Initialize on startup
initializeOpenAI();

// ========================================
// API ENDPOINTS
// ========================================

// Get all leads
app.get('/api/leads', async (req, res) => {
    try {
        const leads = await LeadDatabase.getAllLeads();
        res.json(leads);
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
        
        // Store user message in database
        await LeadDatabase.createMessage(parseInt(leadId), 'user', message);
        
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

        res.json({
            success: true,
            message: 'Lead qualified successfully'
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

        res.json({
            success: true,
            message: 'Lead silently qualified successfully'
        });
    } catch (error) {
        console.error('Error silently qualifying lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// Update all settings (custom questions, assistant name, etc.)
app.post('/api/settings', (req, res) => {
    try {
        const { customQuestions, assistantName } = req.body;
        
        console.log('📝 Updating settings...');
        console.log('   Custom Questions:', customQuestions);
        console.log('   Assistant Name:', assistantName);
        
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
        
        res.json({
            success: true,
            message: 'Settings updated successfully (saved to database)',
            customQuestions: CUSTOM_QUESTIONS,
            assistantName: ASSISTANT_NAME
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
app.get('/api/settings', (req, res) => {
    try {
        res.json({
            success: true,
            customQuestions: CUSTOM_QUESTIONS,
            assistantName: ASSISTANT_NAME
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

// Create new lead
app.post('/api/leads', async (req, res) => {
    try {
        console.log('📝 Creating new lead...');
        console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

        const { name, email, phone, source } = req.body;

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
                
                // Get fresh lead data
                existingLead = await LeadDatabase.getLeadById(existingLead.id);
                
                // Send AI introduction for the NEW inquiry
                try {
                    await sendAIIntroduction(existingLead, true); // true = returning customer
                } catch (introError) {
                    console.error('Error sending AI introduction:', introError);
                }
                
                return res.json(existingLead);
            }
            
            // Lead exists but not qualified yet - just return it
            console.log(`✅ Using existing/restored unqualified lead: ${existingLead.name} (ID: ${existingLead.id})`);
            return res.json(existingLead);
        }
        
        // Create new lead in database
        const newLead = await LeadDatabase.createLead({
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
        
        // Send AI introduction message (don't fail the request if this fails)
        try {
            await sendAIIntroduction(newLead, false); // false = new customer
        } catch (introError) {
            console.error('Error sending AI introduction:', introError);
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
        const { phone, source, name, email } = req.body;
        
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }
        
        const normalizedPhone = normalizePhoneNumber(phone);
        console.log(`🔄 New lead submission from ${source || 'external'}: ${normalizedPhone}`);
        
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
                
                // Get fresh lead data
                lead = await LeadDatabase.getLeadById(lead.id);
                
                // Send AI introduction for the NEW inquiry
                await sendAIIntroduction(lead, true); // Pass true for "returning customer"
                
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
            
            // Send AI introduction
            await sendAIIntroduction(lead, false);
            
            res.json({
                success: true,
                message: 'New lead created successfully',
                leadId: lead.id,
                action: 'created'
            });
        }
    } catch (error) {
        console.error('❌ Error processing external lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
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
                answeredQuestions: Object.keys(lead.answers || {}).length,
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
        
        const firstQuestion = CUSTOM_QUESTIONS[0];
        const questionText = typeof firstQuestion === 'object' ? firstQuestion.question : firstQuestion;
        
        let introMessage;
        
        if (isReturning) {
            // Personalized message for returning customers
            introMessage = `Hi ${lead.name}! Great to hear from you again! 👋

I see you have a new inquiry. Let me ask you a few quick questions about your current needs so we can help you properly.

${questionText}`;
        } else {
            // Standard welcome for new customers
            introMessage = `Hi ${lead.name}! 👋 

I'm ${ASSISTANT_NAME}, your AI assistant from CSGB Cheshire Stables. I'm here to help you find the perfect equine stable solution.

${questionText}`;
        }
        
        await sendSMS(lead.phone, introMessage);
        
        // Store introduction message in database
        await LeadDatabase.createMessage(lead.id, 'assistant', introMessage);
        
        console.log(`✅ AI introduction sent${isReturning ? ' (returning customer)' : ''}`);
        console.log(`📝 First question: ${questionText}`);
    } catch (error) {
        console.error('❌ Error sending AI introduction:', error);
        throw error;
    }
}

// Extract answer for a specific question from the user's message
function extractAnswerForQuestion(userMessage, possibleAnswers, questionNumber) {
    if (!userMessage || !possibleAnswers) return null;
    
    const messageLower = userMessage.toLowerCase().trim();
    const expectedList = possibleAnswers.toLowerCase().split(',').map(a => a.trim());
    
    console.log(`      🔍 Checking Q${questionNumber} against: "${userMessage}"`);
    console.log(`      📋 Looking for: ${expectedList.join(', ')}`);
    
    // Special handling for postcode question (usually question 4)
    if (possibleAnswers.toLowerCase().includes('postcode') || 
        possibleAnswers.toLowerCase().includes('any postcode format')) {
        
        // Check for collection/pickup keywords first
        const collectionKeywords = [
            'collection', 'collect', 'pickup', 'pick up', 'pick-up', 
            'ill get it', "i'll get it", 'i will get it', 'getting it',
            'ill collect', "i'll collect", 'i will collect'
        ];
        
        for (const keyword of collectionKeywords) {
            const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
            if (regex.test(messageLower)) {
                const match = userMessage.match(regex);
                if (match) {
                    console.log(`      ✅ Found collection keyword: ${match[0]}`);
                    return match[0]; // Return the matched text (e.g., "Collection", "Pick up")
                }
            }
        }
        
        // UK postcode patterns (comprehensive list - full and partial)
        const postcodePatterns = [
            /\b([A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2})\b/gi,  // Standard UK format (e.g., CH1 4DF, M1 1AE)
            /\b([A-Z]{2}\d\s?\d[A-Z]{2})\b/gi,               // Two letter prefix (e.g., CH1 4DF)
            /\b([A-Z]\d{1,2}\s?\d[A-Z]{2})\b/gi,             // Single letter prefix (e.g., M1 1AE)
            /\b([A-Z]{1,2}\d[A-Z]\s?\d[A-Z]{2})\b/gi,        // With letter after number (e.g., EC1A 1BB)
            /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/gi                // Partial postcode - outward code only (e.g., CW7, CH1, M1)
        ];
        
        for (const pattern of postcodePatterns) {
            const postcodeMatch = userMessage.match(pattern);
            if (postcodeMatch && postcodeMatch[0]) {
                const postcode = postcodeMatch[0].trim().toUpperCase();
                console.log(`      ✅ Found postcode (pattern match): ${postcode}`);
                return postcode;
            }
        }
        
        // Also check for "postcode is X", "postcode: X", or just any UK postcode-like format
        const postcodeTextMatch = userMessage.match(/postcode[:\s]+([A-Z0-9\s]{4,9})/gi);
        if (postcodeTextMatch && postcodeTextMatch[0]) {
            const extracted = postcodeTextMatch[0].replace(/postcode[:\s]+/gi, '').trim().toUpperCase();
            console.log(`      ✅ Found postcode via text match: ${extracted}`);
            return extracted;
        }
        
        console.log(`      ❓ No postcode or collection keyword found in message`);
    }
    
    // Check for exact word/phrase matches from expected answers
    let bestMatch = null;
    let longestMatch = 0;
    
    for (const expected of expectedList) {
        if (expected.length < 2) continue; // Skip very short matches
        if (expected === 'blank' || expected === 'unsure' || expected === 'not') continue; // Skip generic words
        
        // Look for the expected answer as a word or phrase in the message
        if (messageLower.includes(expected)) {
            // Find the actual text (could be capitalized differently)
            const regex = new RegExp(`\\b${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
            const match = userMessage.match(regex);
            
            if (match && match[0].length > longestMatch) {
                bestMatch = match[0];
                longestMatch = match[0].length;
                console.log(`      🔍 Found exact match: "${match[0]}" for expected: "${expected}"`);
            }
        }
    }
    
    // Log the best exact match found (if any)
    if (bestMatch && longestMatch > 0) {
        console.log(`      ✅ Best exact match: "${bestMatch}" (${longestMatch} chars)`);
    }
    
    // Check for common variations and timeframe patterns
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
        'yes': ['yeah', 'yep', 'sure', 'definitely', 'absolutely'],  // Removed single 'y' to prevent false matches
        'no': ['nope', 'nah', 'not really', 'negative']
    };
    
    for (const [key, variants] of Object.entries(variations)) {
        if (expectedList.includes(key)) {
            for (const variant of variants) {
                // Use word boundary matching to prevent substring matches (e.g., "y" in "urgently")
                const regex = new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
                const match = userMessage.match(regex);
                if (match) {
                    const matchedText = match[0];
                    console.log(`      🔍 Found variation match: "${matchedText}" for key: "${key}" (variant: "${variant}")`);
                    if (matchedText.length > longestMatch) {
                        bestMatch = matchedText;  // Use actual matched text from message
                        longestMatch = matchedText.length;
                    }
                }
            }
        }
    }
    
    if (bestMatch) {
        console.log(`      ✅ Final match selected: "${bestMatch}"`);
        return bestMatch;
    }
    
    // IMPORTANT: Only return null if no match found
    // Do NOT accept arbitrary text as an answer for specific questions
    // This prevents false positives where Q2 gets extracted when not mentioned
    console.log(`      ❌ No match found - returning null (no false positive)`);
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
        
        // More lenient postcode patterns
        const postcodePatterns = [
            /^[a-z]{1,2}\d{1,2}[a-z]?\s?\d[a-z]{2}$/i,  // Standard UK format
            /^[a-z]{2}\d\s?\d[a-z]{2}$/i,               // Simplified format
            /\b[a-z]{1,2}\d{1,2}\s?\d[a-z]{2}\b/gi      // Embedded in text
        ];
        
        for (const pattern of postcodePatterns) {
            if (pattern.test(userAnswer)) {
                console.log(`      ✅ Postcode pattern match found`);
                return true;
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
                const simpleResponse = "You are very welcome";
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
            const autoResponse = "Thanks for your message! Our team has all your details and will be in touch within 24 hours as discussed. If you have any urgent questions, feel free to give us a call during business hours (Mon-Fri 8am-5pm, Sat 10am-3pm).";
            
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
        const answeredCountBefore = Object.keys(lead.answers).length;
        
        console.log(`📊 Current state: ${answeredCountBefore} questions already answered`);
        console.log(`📋 Existing answers:`, JSON.stringify(lead.answers, null, 2));
        
        // NEW: Try to extract answers for ALL unanswered questions from the message
        if (answeredCountBefore < CUSTOM_QUESTIONS.length && userMessage.trim().length > 0) {
            console.log(`🔍 Scanning message for multiple answers...`);
            let newAnswersFound = 0;
            
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
                    lead.answers[questionKey] = extractedAnswer;
                    newAnswersFound++;
                    console.log(`   ✅ Found answer for Q${i + 1}: "${extractedAnswer}"`);
                } else {
                    console.log(`   ❓ No match found for Q${i + 1} in this message`);
                }
            }
            
            // Update progress if any new answers were found
            if (newAnswersFound > 0) {
                const newAnsweredCount = Object.keys(lead.answers).length;
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
        const answeredCount = Object.keys(lead.answers || {}).length;
        console.log(`📊 Current progress: ${answeredCount}/4 questions answered`);
        console.log(`📋 Current answers:`, lead.answers);
        
        if (answeredCount >= 4 && !lead.qualified) {
            console.log(`🎉 All questions answered - qualifying lead`);
            
            // All questions answered - qualify lead (only send this message once)
            const qualificationMessage = `Thank you! I have all the information I need to help you. Based on your answers, someone will contact you within 24 hours to discuss your requirements. If you have any questions in the meantime, feel free to ask! 🐴✨
Our office hours are Monday to Friday, 8am – 5pm, and Saturday, 10am – 3pm.`;

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
        const answersJustExtracted = Object.keys(lead.answers).length - answeredCountBefore;
        const aiResponse = await generateAIResponseWithAssistant(lead, userMessage, answersJustExtracted);
        
        if (aiResponse) {
            console.log(`📤 Sending AI response: "${aiResponse}"`);
            await sendSMS(lead.phone, aiResponse);
            
            // Store AI response in database
            LeadDatabase.createMessage(lead.id, 'assistant', aiResponse);
            
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
        const answeredCount = Object.keys(lead.answers || {}).length;
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
        
        // Find the FIRST unanswered question (not just based on count)
        let nextQuestionIndex = -1;
        let nextQuestion = null;
        
        for (let i = 0; i < CUSTOM_QUESTIONS.length; i++) {
            const questionKey = `question_${i + 1}`;
            if (!lead.answers || !lead.answers[questionKey]) {
                nextQuestionIndex = i + 1;
                nextQuestion = CUSTOM_QUESTIONS[i];
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
3. If ANSWERS_JUST_EXTRACTED > 1, acknowledge multiple answers (e.g., "Perfect! I've captured several details from your message.")
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
    const answeredCount = Object.keys(lead.answers || {}).length;
    
    console.log(`📊 Lead progress: ${answeredCount}/${CUSTOM_QUESTIONS.length} questions answered`);
    console.log(`📝 Custom questions:`, CUSTOM_QUESTIONS);
    console.log(`💬 User message length: ${userMessage.length} characters`);
    
    // Note: Answer storage happens in processAIResponse() before this function is called
    // Do NOT store answers here to avoid duplicate storage
    
    if (answeredCount < CUSTOM_QUESTIONS.length) {
        const q = CUSTOM_QUESTIONS[answeredCount];
        const nextQuestion = typeof q === 'object' ? q.question : q;
        console.log(`❓ Asking question ${answeredCount + 1}: ${nextQuestion}`);
        
        // Ask the next question with acknowledgment
        const acknowledgments = [
            "Got it! ",
            "Perfect! ",
            "Thanks! ",
            "Excellent! ",
            "Great! "
        ];
        const randomAck = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
        
        const response = `${randomAck}${nextQuestion}`;
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
        const answeredCount = Object.keys(lead.answers || {}).length;
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
        const answeredCount = Object.keys(lead.answers || {}).length;
        
        if (answeredCount < CUSTOM_QUESTIONS.length && userMessage.length > 5) {
            // Store the answer
            const questionKey = `question_${answeredCount + 1}`;
            lead.answers = lead.answers || {};
            lead.answers[questionKey] = userMessage;
            
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