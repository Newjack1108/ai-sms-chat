// Lead Qualification System - Clean Slate v1.0.0
const express = require('express');
const path = require('path');
const cors = require('cors');
const twilio = require('twilio');

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

// Custom questions for lead qualification
const CUSTOM_QUESTIONS = {
    q1: "How many horses do you currently have?",
    q2: "What type of stable configuration interests you most?",
    q3: "What's your budget range for this project?",
    q4: "What's your ideal timeline for completion?"
};

// ========================================
// API ENDPOINTS
// ========================================

// Get all leads
app.get('/api/leads', (req, res) => {
    try {
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
            questions: {
                q1: { answered: false, answer: '' },
                q2: { answered: false, answer: '' },
                q3: { answered: false, answer: '' },
                q4: { answered: false, answer: '' }
            },
            createdAt: new Date().toISOString()
        };
        
        leads.push(newLead);
        
        // Send AI introduction message
        await sendAIIntroduction(newLead);
        
        res.json({
            success: true,
            lead: newLead
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
        const { Body, From, To, MessageSid } = req.body;
        
        console.log(`📥 Incoming SMS from ${From}: "${Body}"`);
        
        const normalizedPhone = normalizePhoneNumber(From);
        
        // Get or create lead
        let lead = leads.find(l => l.phone === normalizedPhone);
        if (!lead) {
            lead = {
                id: leadIdCounter++,
                name: 'Unknown',
                email: '',
                phone: normalizedPhone,
                source: 'inbound_sms',
                status: 'new',
                progress: 0,
                qualified: false,
                questions: {
                    q1: { answered: false, answer: '' },
                    q2: { answered: false, answer: '' },
                    q3: { answered: false, answer: '' },
                    q4: { answered: false, answer: '' }
                },
                createdAt: new Date().toISOString()
            };
            leads.push(lead);
        }
        
        // Process AI response
        await processAIResponse(lead, Body);
        
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
async function sendAIIntroduction(lead) {
    try {
        const introductionMessage = `Hi ${lead.name}! 👋 

I'm your AI assistant from Cheshire Sheds. I'm here to help you find the perfect equine stable solution for your horses.

To get started, I have a few quick questions to understand your needs better. Let's begin! 🐴`;

        await sendSMS(lead.phone, introductionMessage);
        
        console.log(`🤖 AI introduction sent to ${lead.name} (${lead.phone})`);
    } catch (error) {
        console.error('Error sending AI introduction:', error);
    }
}

// Process AI response
async function processAIResponse(lead, userMessage) {
    try {
        // Check which questions are already answered
        const answeredQuestions = [];
        const unansweredQuestions = [];
        
        ['q1', 'q2', 'q3', 'q4'].forEach((q, index) => {
            if (lead.questions[q]?.answered) {
                answeredQuestions.push(`${CUSTOM_QUESTIONS[q]}: ${lead.questions[q].answer}`);
            } else {
                unansweredQuestions.push(CUSTOM_QUESTIONS[q]);
            }
        });
        
        // If all questions are answered, send qualification message
        if (unansweredQuestions.length === 0) {
            const qualificationMessage = `🎉 Excellent! I have all the information I need to help you.

Based on your answers, I'll have our team prepare a customized proposal for your equine stable project. Someone will contact you within 24 hours to discuss next steps.

Thank you for your time! 🐴✨`;

            await sendSMS(lead.phone, qualificationMessage);
            
            // Mark as qualified
            lead.qualified = true;
            lead.qualifiedDate = new Date().toISOString();
            lead.status = 'qualified';
            lead.progress = 100;
            
            console.log(`🎉 Lead qualified: ${lead.name} (${lead.phone})`);
            return;
        }
        
        // Generate AI response for next question
        const aiResponse = await generateAIResponse(lead, userMessage, unansweredQuestions);
        
        if (aiResponse) {
            await sendSMS(lead.phone, aiResponse);
            
            console.log(`🤖 AI response sent to ${lead.name} (${lead.phone}): "${aiResponse}"`);
        }
    } catch (error) {
        console.error('Error processing AI response:', error);
    }
}

// Generate AI response
async function generateAIResponse(lead, userMessage, unansweredQuestions) {
    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        // Find the next question to ask
        const nextQuestion = unansweredQuestions[0];
        const questionKey = Object.keys(CUSTOM_QUESTIONS).find(key => 
            CUSTOM_QUESTIONS[key] === nextQuestion
        );
        
        const context = `You are a sales assistant helping to qualify leads for an equine stable business.

Customer: ${lead.name} (${lead.phone})
Email: ${lead.email || 'Not provided'}

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
            lead.questions[questionKey] = {
                answered: true,
                answer: userMessage,
                answeredDate: new Date().toISOString()
            };
            
            // Update progress
            const answeredCount = Object.values(lead.questions).filter(q => q.answered).length;
            lead.progress = Math.round((answeredCount / 4) * 100);
            lead.status = lead.progress === 100 ? 'qualified' : 'in-progress';
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

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Lead Qualification System running on port ${PORT}`);
    console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook/sms`);
    console.log(`🌐 Web Interface: http://localhost:${PORT}`);
    console.log(`🎯 Clean, simple lead qualification system ready!`);
});