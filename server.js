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

// Default custom questions for lead qualification (can be updated via API)
let CUSTOM_QUESTIONS = [
    {
        question: "What type of building do you require?",
        possibleAnswers: "Double, Single, Stables, Stable, Field shelter, Barn, 24ft, 12ft, 36ft, tack room"
    },
    {
        question: "Does your building need to be mobile?",
        possibleAnswers: "skids, mobile, towable, yes, moveable, steel skid, wooden skids, no, static"
    },
    {
        question: "How soon do you need the building?",
        possibleAnswers: "ASAP, asap, week, weeks, tbc, TBC, month, months, next year, day, days, don't mind, anytime, not fussed"
    },
    {
        question: "Did you supply the postcode where the building is to be installed?",
        possibleAnswers: "blank, unsure, not, any postcode format (lowercase and uppercase)"
    }
];

// Assistant name (can be updated via API)
let ASSISTANT_NAME = "Oscar";

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
            console.log('✅ Custom questions updated with possible answers');
        }
        
        // Update assistant name if provided
        if (assistantName && assistantName.trim().length > 0) {
            ASSISTANT_NAME = assistantName.trim();
            console.log('✅ Assistant name updated to:', ASSISTANT_NAME);
        }
        
        res.json({
            success: true,
            message: 'Settings updated successfully',
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
        const firstQuestion = typeof CUSTOM_QUESTIONS[0] === 'object' ? CUSTOM_QUESTIONS[0].question : CUSTOM_QUESTIONS[0];
        
        const introductionMessage = `Hi ${lead.name}! 👋 

I'm ${ASSISTANT_NAME}, your AI assistant from CSGB Cheshire Stables. I'm here to help you find the perfect equine stable solution.

${firstQuestion}`;

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
        
        console.log(`🤖 ${ASSISTANT_NAME} introduction sent to ${lead.name} (${lead.phone})`);
        console.log(`📝 First question from custom questions: ${CUSTOM_QUESTIONS[0]}`);
    } catch (error) {
        console.error('Error sending AI introduction:', error);
    }
}

// Process AI response using OpenAI Assistant
async function processAIResponse(lead, userMessage) {
    try {
        console.log(`🔄 Processing AI response for lead: ${lead.name} (${lead.phone})`);
        console.log(`📝 User message: "${userMessage}"`);
        
        // Store incoming message
        const incomingMessage = {
            id: messageIdCounter++,
            leadId: lead.id,
            sender: 'customer',
            content: userMessage,
            timestamp: new Date().toISOString()
        };
        messages.push(incomingMessage);
        
        // Check if lead is already qualified - if so, enter free chat mode
        if (lead.qualified === true || lead.status === 'qualified') {
            console.log(`💬 Lead already qualified - entering free chat mode`);
            
            // Generate friendly conversational response
            const aiResponse = await generateQualifiedChatResponse(lead, userMessage);
            
            if (aiResponse) {
                console.log(`📤 Sending chat response: "${aiResponse}"`);
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
                
                console.log(`✅ Chat response sent to ${lead.name} (${lead.phone})`);
            }
            return;
        }
        
        // FIRST: Extract answer from user message BEFORE generating AI response
        console.log(`🔍 Extracting answer BEFORE generating response...`);
        const answeredCountBefore = Object.keys(lead.answers || {}).length;
        
        // Simple answer storage for current unanswered question
        if (answeredCountBefore < CUSTOM_QUESTIONS.length && userMessage.trim().length > 0) {
            const questionKey = `question_${answeredCountBefore + 1}`;
            lead.answers = lead.answers || {};
            lead.answers[questionKey] = userMessage;
            
            // Update progress
            const newAnsweredCount = Object.keys(lead.answers).length;
            lead.progress = Math.round((newAnsweredCount / 4) * 100);
            lead.status = lead.progress === 100 ? 'qualified' : 'active';
            
            console.log(`✅ Stored answer for question ${answeredCountBefore + 1}: "${userMessage}"`);
            console.log(`📈 Progress updated: ${newAnsweredCount}/4 questions (${lead.progress}%)`);
        }
        
        // Check if all questions are answered NOW (after storing answer)
        const answeredCount = Object.keys(lead.answers || {}).length;
        console.log(`📊 Current progress: ${answeredCount}/4 questions answered`);
        console.log(`📋 Current answers:`, lead.answers);
        
        if (answeredCount >= 4 && !lead.qualified) {
            console.log(`🎉 All questions answered - qualifying lead for FIRST TIME`);
            // All questions answered - qualify lead (only send this message once)
            const qualificationMessage = `🎉 Excellent! I have all the information I need to help you.

Based on your answers, I'll have our team prepare a customized proposal for your equine stable project. Someone will contact you within 24 hours to discuss next steps.

If you have any questions in the meantime, feel free to ask! 🐴✨`;

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
        
        console.log(`🤖 Generating AI response...`);
        // Generate AI response using Assistant
        const aiResponse = await generateAIResponseWithAssistant(lead, userMessage);
        
        if (aiResponse) {
            console.log(`📤 Sending AI response: "${aiResponse}"`);
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
            
            console.log(`✅ AI response sent to ${lead.name} (${lead.phone}): "${aiResponse}"`);
        } else {
            console.log(`❌ No AI response generated`);
        }
    } catch (error) {
        console.error('❌ Error processing AI response:', error);
    }
}

// Generate AI response using OpenAI Assistant
async function generateAIResponseWithAssistant(lead, userMessage) {
    try {
        console.log(`🔍 Checking AI configuration...`);
        console.log(`🤖 OpenAI Client:`, openaiClient ? 'Available' : 'Not available');
        console.log(`🆔 Assistant ID:`, assistantId ? assistantId : 'Not set');
        
        if (!openaiClient || !assistantId) {
            console.log('⚠️ OpenAI Assistant not configured - using fallback response');
            return await generateFallbackResponse(lead, userMessage);
        }
        
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
        
        let contextInstructions = `You are ${ASSISTANT_NAME}, helping to qualify a lead named ${lead.name} for an equine stable project.

CRITICAL: You must ONLY gather answers to these EXACT 4 questions - DO NOT ask about anything else:

${questionsText}

✅ INFORMATION ALREADY GATHERED (DO NOT ASK THESE AGAIN):
${gatheredInfo.length > 0 ? gatheredInfo.join('\n') : 'None yet'}

❓ STILL NEED ANSWERS FOR (ASK ONLY THESE):
${unansweredQuestions.length > 0 ? unansweredQuestions.map((q, i) => {
    const questionText = typeof q === 'object' ? q.question : q;
    const possibleAnswers = typeof q === 'object' && q.possibleAnswers ? q.possibleAnswers : '';
    return `${i + 1}. ${questionText}${possibleAnswers ? '\n   Look for: ' + possibleAnswers : ''}`;
}).join('\n') : 'All information gathered!'}

STRICT RULES (FOLLOW EXACTLY):
1. CHECK "INFORMATION ALREADY GATHERED" - if a question is listed there, it's ALREADY ANSWERED. DO NOT ASK IT AGAIN.
2. ONLY ask questions from "STILL NEED ANSWERS FOR" section
3. Accept any response as a valid answer - don't ask follow-up questions
4. Brief acknowledgment (2-3 words) + next question
5. Keep total response under 100 characters
6. Move to the NEXT unanswered question immediately

Customer's message: "${userMessage}"

Brief response format: "[2-3 word acknowledgment] [Next unanswered question]"
Example: "Got it! Does your building need to be mobile?"`;

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
                console.log(`❌ Error:`, runStatus.last_error);
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
        
        // Ask the next question
        if (answeredCount < CUSTOM_QUESTIONS.length) {
            const response = `Thanks! ${nextQuestion}`;
            console.log(`📤 Fallback response: ${response}`);
            return response;
        }
    }
    
    const response = "Thank you for your response! I'll have our team contact you soon.";
    console.log(`📤 Default response: ${response}`);
    return response;
}

// Generate conversational response for qualified leads
async function generateQualifiedChatResponse(lead, userMessage) {
    try {
        console.log(`💬 Generating qualified chat response...`);
        
        if (!openaiClient || !assistantId) {
            console.log('⚠️ OpenAI Assistant not configured - using simple response');
            return "You're welcome! If you have any other questions, our team will be happy to help when they contact you.";
        }
        
        // Build context for post-qualification chat
        const chatInstructions = `You are ${ASSISTANT_NAME}, an AI assistant from CSGB Cheshire Stables specializing in equine stable solutions.

SITUATION: This customer (${lead.name}) has already completed the qualification process. All 4 qualification questions have been answered and they've been informed that our team will contact them within 24 hours.

YOUR ROLE NOW:
- Answer any questions they have about equine stables, buildings, or our services
- Be friendly, helpful, and conversational
- Keep responses brief and natural (under 150 characters when possible)
- Reassure them that our team will be in touch soon
- Handle thank you messages gracefully without repeating the qualification message

THEIR QUALIFICATION INFO (for context):
${Object.entries(lead.answers || {}).map(([key, value], i) => {
    const q = CUSTOM_QUESTIONS[i];
    const questionText = typeof q === 'object' ? q.question : q;
    return `- ${questionText}: ${value}`;
}).join('\n')}

Customer's message: "${userMessage}"

Respond naturally and helpfully. If they say "thank you", "thanks", or similar, acknowledge it warmly without repeating qualification details.`;

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
        let runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 30;
        
        while (runStatus.status !== 'completed' && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
            
            if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
                console.log(`❌ Assistant run failed with status: ${runStatus.status}`);
                throw new Error(`Assistant run ${runStatus.status}`);
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
        console.error('❌ Error generating qualified chat response:', error);
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
            model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
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

// Start the server
app.listen(PORT, () => {
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
    CUSTOM_QUESTIONS.forEach((q, i) => console.log(`   ${i + 1}. ${q}`));
    console.log('\n');
});