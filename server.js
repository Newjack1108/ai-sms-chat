// Lead Qualification System - Clean Slate v1.0.0
const express = require('express');
const path = require('path');
const cors = require('cors');
const twilio = require('twilio');
const { initializeDatabase, CustomerDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize database
let customerDB;

// Custom questions for lead qualification
const CUSTOM_QUESTIONS = {
    q1: "How many horses do you currently have?",
    q2: "What type of stable configuration interests you most?",
    q3: "What's your budget range for this project?",
    q4: "What's your ideal timeline for completion?"
};

// Initialize application
async function initializeApp() {
    try {
        console.log('🚀 Initializing Lead Qualification System...');
        
        // Initialize database
        await initializeDatabase();
        customerDB = new CustomerDatabase();
        
        console.log('✅ Database initialized successfully');
        console.log('🎯 Lead Qualification System ready!');
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        throw error;
    }
}

// ========================================
// API ENDPOINTS
// ========================================

// Get all leads
app.get('/api/leads', async (req, res) => {
    try {
        const customers = await customerDB.getAllCustomers();
        
        // Convert customers to leads format
        const leads = customers.map(customer => ({
            id: customer.id,
            name: customer.name || 'Unknown',
            email: customer.email || '',
            phone: customer.phone,
            source: customer.source || 'manual',
            status: getLeadStatus(customer),
            progress: calculateProgress(customer),
            questions: {
                q1: customer.question1 || { answered: false, answer: '' },
                q2: customer.question2 || { answered: false, answer: '' },
                q3: customer.question3 || { answered: false, answer: '' },
                q4: customer.question4 || { answered: false, answer: '' }
            },
            createdAt: customer.createdAt || new Date().toISOString()
        }));
        
        res.json({
            success: true,
            leads: leads
        });
    } catch (error) {
        console.error('Error fetching leads:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create new lead
app.post('/api/leads', async (req, res) => {
    try {
        const { name, email, phone, source } = req.body;
        
        if (!name || !email || !phone) {
            return res.status(400).json({
                success: false,
                error: 'Name, email, and phone are required'
            });
        }
        
        const normalizedPhone = normalizePhoneNumber(phone);
        
        // Check if lead already exists
        const existingCustomer = await customerDB.getCustomer(normalizedPhone);
        if (existingCustomer) {
            return res.status(400).json({
                success: false,
                error: 'Lead with this phone number already exists'
            });
        }
        
        // Create new customer/lead
        const customer = await customerDB.createCustomer({
            phone: normalizedPhone,
            name: name,
            email: email,
            source: source || 'manual',
            conversationStage: 'new',
            qualified: false
        });
        
        // Send AI introduction message
        await sendAIIntroduction(customer);
        
        res.json({
            success: true,
            lead: {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                source: customer.source,
                status: 'new',
                progress: 0,
                questions: {
                    q1: { answered: false, answer: '' },
                    q2: { answered: false, answer: '' },
                    q3: { answered: false, answer: '' },
                    q4: { answered: false, answer: '' }
                }
            }
        });
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
        
        const customer = await customerDB.getCustomer(leadId);
        if (!customer) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Prepare CRM data
        const crmData = {
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            source: customer.source,
            qualified: true,
            qualificationDate: new Date().toISOString(),
            answers: {
                question1: customer.question1?.answer || '',
                question2: customer.question2?.answer || '',
                question3: customer.question3?.answer || '',
                question4: customer.question4?.answer || ''
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
            await customerDB.updateCustomer(leadId, {
                sentToCRM: true,
                crmSentDate: new Date().toISOString()
            });
            
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
app.delete('/api/leads/:leadId', async (req, res) => {
    try {
        const { leadId } = req.params;
        
        const customer = await customerDB.getCustomer(leadId);
        if (!customer) {
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        // Delete customer from database
        await customerDB.deleteCustomer(leadId);
        
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
        const { Body, From, To, MessageSid } = req.body;
        
        console.log(`📥 Incoming SMS from ${From}: "${Body}"`);
        
        const normalizedPhone = normalizePhoneNumber(From);
        
        // Get or create customer
        let customer = await customerDB.getCustomer(normalizedPhone);
        if (!customer) {
            customer = await customerDB.createCustomer({
                phone: normalizedPhone,
                source: 'inbound_sms'
            });
        }
        
        // Check for duplicate messages
        const existingMessages = customer.chatData?.messages || [];
        const messageExists = existingMessages.some(msg => msg.messageId === MessageSid);
        
        if (messageExists) {
            console.log(`📥 Message ${MessageSid} already processed - skipping`);
            return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }
        
        // Add incoming message to chat data
        const messageData = {
            sender: 'customer',
            message: Body,
            timestamp: new Date().toISOString(),
            messageId: MessageSid
        };
        
        const updatedMessages = [...existingMessages, messageData];
        
        // Update customer with new message
        await customerDB.updateCustomer(normalizedPhone, {
            chatData: {
                ...customer.chatData,
                messages: updatedMessages
            }
        });
        
        // Process AI response
        await processAIResponse(customer, Body);
        
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

// ========================================
// HELPER FUNCTIONS
// ========================================

// Send AI introduction message
async function sendAIIntroduction(customer) {
    try {
        const introductionMessage = `Hi ${customer.name}! 👋 

I'm your AI assistant from Cheshire Sheds. I'm here to help you find the perfect equine stable solution for your horses.

To get started, I have a few quick questions to understand your needs better. Let's begin! 🐴`;

        await sendSMS(customer.phone, introductionMessage);
        
        // Add introduction to chat data
        const messageData = {
            sender: 'assistant',
            message: introductionMessage,
            timestamp: new Date().toISOString(),
            messageId: `intro_${Date.now()}`
        };
        
        const existingMessages = customer.chatData?.messages || [];
        const updatedMessages = [...existingMessages, messageData];
        
        await customerDB.updateCustomer(customer.phone, {
            chatData: {
                ...customer.chatData,
                messages: updatedMessages
            }
        });
        
        console.log(`🤖 AI introduction sent to ${customer.name} (${customer.phone})`);
    } catch (error) {
        console.error('Error sending AI introduction:', error);
    }
}

// Process AI response
async function processAIResponse(customer, userMessage) {
    try {
        // Check which questions are already answered
        const answeredQuestions = [];
        const unansweredQuestions = [];
        
        ['question1', 'question2', 'question3', 'question4'].forEach((q, index) => {
            if (customer[q]?.answered) {
                answeredQuestions.push(`${CUSTOM_QUESTIONS[`q${index + 1}`]}: ${customer[q].answer}`);
            } else {
                unansweredQuestions.push(CUSTOM_QUESTIONS[`q${index + 1}`]);
            }
        });
        
        // If all questions are answered, send qualification message
        if (unansweredQuestions.length === 0) {
            const qualificationMessage = `🎉 Excellent! I have all the information I need to help you.

Based on your answers, I'll have our team prepare a customized proposal for your equine stable project. Someone will contact you within 24 hours to discuss next steps.

Thank you for your time! 🐴✨`;

            await sendSMS(customer.phone, qualificationMessage);
            
            // Mark as qualified
            await customerDB.updateCustomer(customer.phone, {
                qualified: true,
                qualifiedDate: new Date().toISOString()
            });
            
            console.log(`🎉 Lead qualified: ${customer.name} (${customer.phone})`);
            return;
        }
        
        // Generate AI response for next question
        const aiResponse = await generateAIResponse(customer, userMessage, unansweredQuestions);
        
        if (aiResponse) {
            await sendSMS(customer.phone, aiResponse);
            
            // Add AI response to chat data
            const messageData = {
                sender: 'assistant',
                message: aiResponse,
                timestamp: new Date().toISOString(),
                messageId: `ai_${Date.now()}`
            };
            
            const existingMessages = customer.chatData?.messages || [];
            const updatedMessages = [...existingMessages, messageData];
            
            await customerDB.updateCustomer(customer.phone, {
                chatData: {
                    ...customer.chatData,
                    messages: updatedMessages
                }
            });
            
            console.log(`🤖 AI response sent to ${customer.name} (${customer.phone}): "${aiResponse}"`);
        }
    } catch (error) {
        console.error('Error processing AI response:', error);
    }
}

// Generate AI response
async function generateAIResponse(customer, userMessage, unansweredQuestions) {
    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        // Find the next question to ask
        const nextQuestion = unansweredQuestions[0];
        const questionNumber = Object.keys(CUSTOM_QUESTIONS).find(key => 
            CUSTOM_QUESTIONS[key] === nextQuestion
        );
        
        const context = `You are a sales assistant helping to qualify leads for an equine stable business.

Customer: ${customer.name} (${customer.phone})
Email: ${customer.email || 'Not provided'}

Next question to ask: ${nextQuestion}

Customer's latest message: "${userMessage}"

Your task:
1. Acknowledge their response if it answers the previous question
2. Ask the next question naturally
3. Be friendly, professional, and helpful
4. Keep responses concise (under 160 characters for SMS)
5. If they haven't answered the previous question clearly, ask for clarification

Respond naturally to their message while asking the next question.`;

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: context },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 150,
            temperature: 0.7
        });
        
        const response = completion.choices[0].message.content.trim();
        
        // Try to extract answer from user message
        if (userMessage.length > 5) { // Basic check for meaningful response
            await customerDB.updateCustomer(customer.phone, {
                [questionNumber]: {
                    answered: true,
                    answer: userMessage,
                    answeredDate: new Date().toISOString()
                }
            });
        }
        
        return response;
    } catch (error) {
        console.error('Error generating AI response:', error);
        return null;
    }
}

// Send SMS
async function sendSMS(to, message) {
    try {
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
    
    // Add +1 if it's a 10-digit US number
    if (digits.length === 10) {
        return '+1' + digits;
    }
    
    // Add + if it doesn't start with +
    if (!phone.startsWith('+')) {
        return '+' + digits;
    }
    
    return phone;
}

function calculateProgress(customer) {
    const questions = ['question1', 'question2', 'question3', 'question4'];
    const answered = questions.filter(q => customer[q]?.answered).length;
    return Math.round((answered / 4) * 100);
}

function getLeadStatus(customer) {
    const progress = calculateProgress(customer);
    if (progress === 100) return 'qualified';
    if (progress > 0) return 'in-progress';
    return 'new';
}

// Start the application
initializeApp().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Lead Qualification System running on port ${PORT}`);
        console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook/sms`);
        console.log(`🌐 Web Interface: http://localhost:${PORT}`);
    });
}).catch(error => {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
});
