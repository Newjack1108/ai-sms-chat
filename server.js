// Lead Qualification System - Professional CRM Interface v2.0.0
const express = require('express');
const path = require('path');
const cors = require('cors');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Simple in-memory storage for demo (will be replaced with database)
let leads = [];
let leadIdCounter = 1;
let messages = [];
let messageIdCounter = 1;

// Default custom questions for lead qualification
let CUSTOM_QUESTIONS = [
    "How many horses do you currently have?",
    "What type of stable configuration interests you most?",
    "What's your budget range for this project?",
    "What's your ideal timeline for completion?"
];

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
    } else {
        console.log('⚠️ OpenAI API key not configured');
    }
}

// Initialize on startup
initializeOpenAI();

// ========================================
// API ENDPOINTS
// ========================================

// Get all leads
app.get('/api/leads', (req, res) => {
    try {
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
app.get('/api/leads/:leadId/messages', (req, res) => {
    try {
        const { leadId } = req.params;
        const leadMessages = messages.filter(msg => msg.leadId == leadId);
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
        
        const lead = leads.find(l => l.id == leadId);
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Store user message
        const userMessage = {
            id: messageIdCounter++,
            leadId: leadId,
            sender: 'user',
            content: message,
            timestamp: new Date().toISOString()
        };
        messages.push(userMessage);
        
        // Send SMS to customer
        await sendSMS(lead.phone, message);
        
        // Generate AI response
        const aiResponse = await generateAIResponseWithAssistant(lead, message);
        
        if (aiResponse) {
            // Store AI response
            const aiMessage = {
                id: messageIdCounter++,
                leadId: leadId,
                sender: 'assistant',
                content: aiResponse,
                timestamp: new Date().toISOString()
            };
            messages.push(aiMessage);
            
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
        const { leadId } = req.params;
        
        const lead = leads.find(l => l.id == leadId);
        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Mark as qualified
        lead.qualified = true;
        lead.status = 'qualified';
        lead.progress = 100;
        lead.qualifiedDate = new Date().toISOString();
        
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

// Update custom questions
app.post('/api/settings/questions', (req, res) => {
    try {
        const { questions } = req.body;
        
        if (!questions || !Array.isArray(questions) || questions.length !== 4) {
            return res.status(400).json({
                success: false,
                error: 'Exactly 4 questions are required'
            });
        }
        
        CUSTOM_QUESTIONS = questions;
        
        res.json({
            success: true,
            message: 'Custom questions updated successfully'
        });
    } catch (error) {
        console.error('Error updating questions:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get custom questions
app.get('/api/settings/questions', (req, res) => {
    try {
        res.json({
            success: true,
            questions: CUSTOM_QUESTIONS
        });
    } catch (error) {
        console.error('Error fetching questions:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
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
        
        // Check if lead already exists
        const existingLead = leads.find(lead => lead.phone === normalizedPhone);
        if (existingLead) {
            return res.status(400).json({
                success: false,
                error: 'Lead with this phone number already exists'
            });
        }
        
        // Create new lead
        const newLead = {
            id: leadIdCounter++,
            name: name,
            email: email,
            phone: normalizedPhone,
            source: source || 'manual',
            status: 'new',
            progress: 0,
            qualified: false,
            answers: {},
            createdAt: new Date().toISOString()
        };
        
        leads.push(newLead);
        
        // Send AI introduction message (don't fail the request if this fails)
        try {
            await sendAIIntroduction(newLead);
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
        
        const leadIndex = leads.findIndex(l => l.id == leadId);
        if (leadIndex === -1) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Remove lead from array
        leads.splice(leadIndex, 1);

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
        
        // Get or create lead
        let lead = leads.find(l => l.phone === normalizedPhone);
        if (!lead) {
            console.log(`👤 Creating new lead for ${normalizedPhone}`);
            lead = {
                id: leadIdCounter++,
                name: 'Unknown',
                email: '',
                phone: normalizedPhone,
                source: 'inbound_sms',
                status: 'new',
                progress: 0,
                qualified: false,
                answers: {},
                createdAt: new Date().toISOString()
            };
            leads.push(lead);
        } else {
            console.log(`👤 Found existing lead: ${lead.name} (${lead.phone})`);
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
async function sendAIIntroduction(lead) {
    try {
        const introductionMessage = `Hi ${lead.name}! 👋 

I'm your AI assistant from Cheshire Sheds. I'm here to help you find the perfect equine stable solution for your horses.

To get started, I have a few quick questions to understand your needs better. Let's begin! 🐴`;

        await sendSMS(lead.phone, introductionMessage);
        
        // Store introduction message
        const introMessage = {
            id: messageIdCounter++,
            leadId: lead.id,
            sender: 'assistant',
            content: introductionMessage,
            timestamp: new Date().toISOString()
        };
        messages.push(introMessage);
        
        console.log(`🤖 AI introduction sent to ${lead.name} (${lead.phone})`);
    } catch (error) {
        console.error('Error sending AI introduction:', error);
    }
}

// Process AI response using OpenAI Assistant
async function processAIResponse(lead, userMessage) {
    try {
        // Store incoming message
        const incomingMessage = {
            id: messageIdCounter++,
            leadId: lead.id,
            sender: 'customer',
            content: userMessage,
            timestamp: new Date().toISOString()
        };
        messages.push(incomingMessage);
        
        // Check if all questions are answered
        const answeredCount = Object.keys(lead.answers || {}).length;
        
        if (answeredCount >= 4) {
            // All questions answered - qualify lead
            const qualificationMessage = `🎉 Excellent! I have all the information I need to help you.

Based on your answers, I'll have our team prepare a customized proposal for your equine stable project. Someone will contact you within 24 hours to discuss next steps.

Thank you for your time! 🐴✨`;

            await sendSMS(lead.phone, qualificationMessage);
            
            // Store qualification message
            const qualMessage = {
                id: messageIdCounter++,
                leadId: lead.id,
                sender: 'assistant',
                content: qualificationMessage,
                timestamp: new Date().toISOString()
            };
            messages.push(qualMessage);
            
            // Mark as qualified
            lead.qualified = true;
            lead.qualifiedDate = new Date().toISOString();
            lead.status = 'qualified';
            lead.progress = 100;
            
            console.log(`🎉 Lead qualified: ${lead.name} (${lead.phone})`);
            return;
        }
        
        // Generate AI response using Assistant
        const aiResponse = await generateAIResponseWithAssistant(lead, userMessage);
        
        if (aiResponse) {
            await sendSMS(lead.phone, aiResponse);
            
            // Store AI response
            const aiMessage = {
                id: messageIdCounter++,
                leadId: lead.id,
                sender: 'assistant',
                content: aiResponse,
                timestamp: new Date().toISOString()
            };
            messages.push(aiMessage);
            
            console.log(`🤖 AI response sent to ${lead.name} (${lead.phone}): "${aiResponse}"`);
        }
    } catch (error) {
        console.error('Error processing AI response:', error);
    }
}

// Generate AI response using OpenAI Assistant
async function generateAIResponseWithAssistant(lead, userMessage) {
    try {
        if (!openaiClient || !assistantId) {
            console.log('⚠️ OpenAI Assistant not configured - using fallback response');
            return generateFallbackResponse(lead, userMessage);
        }
        
        // Create a thread for this conversation
        const thread = await openaiClient.beta.threads.create();
        
        // Add user message to thread
        await openaiClient.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: userMessage
        });
        
        // Run the assistant
        const run = await openaiClient.beta.threads.runs.create(thread.id, {
            assistant_id: assistantId
        });
        
        // Wait for completion
        let runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
        while (runStatus.status !== 'completed') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
        }
        
        // Get the assistant's response
        const messages = await openaiClient.beta.threads.messages.list(thread.id);
        const assistantMessage = messages.data[0];
        
        if (assistantMessage && assistantMessage.content[0].type === 'text') {
            const response = assistantMessage.content[0].text.value;
            
            // Try to extract answer and update lead progress
            await updateLeadProgress(lead, userMessage);
            
            return response;
        }
        
        return generateFallbackResponse(lead, userMessage);
    } catch (error) {
        console.error('Error generating AI response with Assistant:', error);
        return generateFallbackResponse(lead, userMessage);
    }
}

// Fallback response when Assistant is not available
async function generateFallbackResponse(lead, userMessage) {
    const answeredCount = Object.keys(lead.answers || {}).length;
    
    if (answeredCount < CUSTOM_QUESTIONS.length) {
        const nextQuestion = CUSTOM_QUESTIONS[answeredCount];
        return `Thanks for your response! ${nextQuestion}`;
    }
    
    return "Thank you for your response! I'll have our team contact you soon.";
}

// Update lead progress based on user response
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

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Lead Qualification System running on port ${PORT}`);
    console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook/sms`);
    console.log(`🌐 Web Interface: http://localhost:${PORT}`);
    console.log(`🎯 Clean, simple lead qualification system ready!`);
});