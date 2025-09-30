// CRM-Enhanced Equine SMS Server - PostgreSQL Database v2.1.0
const express = require('express');
const path = require('path');
const cors = require('cors');
const twilio = require('twilio');
const fs = require('fs').promises;
const { initializeDatabase, CustomerDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables (for production deployment)
require('dotenv').config();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Special Offers Storage
let specialOffer = null;

// AI Settings Storage
let aiSettings = {
    aiEnabled: true, // Default to enabled
    testMode: false
};

// Initialize global custom questions
global.customQuestions = {
    q1: "How many horses do you currently have?",
    q2: "What type of stable configuration interests you most?",
    q3: "What's your budget range for this project?",
    q4: "What's your ideal timeline for completion?"
};

// Load custom questions with Railway-optimized methods
async function loadCustomQuestions() {
    try {
        // Check environment variables first (Railway's preferred method)
        const envQuestions = {
            q1: process.env.CUSTOM_QUESTION_1,
            q2: process.env.CUSTOM_QUESTION_2,
            q3: process.env.CUSTOM_QUESTION_3,
            q4: process.env.CUSTOM_QUESTION_4
        };
        
        // If all environment variables are set, use them
        if (envQuestions.q1 && envQuestions.q2 && envQuestions.q3 && envQuestions.q4) {
            global.customQuestions = envQuestions;
            console.log('📝 Loaded custom questions from Railway environment variables:', envQuestions);
            return;
        }
        
        // Try local file as fallback
        try {
            const data = await fs.readFile('custom-questions.json', 'utf8');
            const questions = JSON.parse(data);
            global.customQuestions = questions;
            console.log('📝 Loaded custom questions from local file:', questions);
            return;
        } catch (localError) {
            console.log('📝 Local file not found, using default questions');
        }
        
        console.log('📝 Using default questions (set CUSTOM_QUESTION_1-4 environment variables for custom questions)');
        
    } catch (error) {
        console.error('❌ Error loading custom questions:', error);
        console.log('📝 Using default questions due to error');
    }
}

// Save custom questions (Railway-optimized)
async function saveCustomQuestions() {
    try {
        // Try local file (temporary storage)
        try {
            await fs.writeFile('custom-questions.json', JSON.stringify(global.customQuestions, null, 2));
            console.log('📝 Saved custom questions to local file:', global.customQuestions);
            console.log('📝 Note: For permanent storage, set CUSTOM_QUESTION_1-4 environment variables in Railway');
        } catch (localError) {
            console.log('📝 Local file save failed, data will be lost on restart');
            console.log('📝 Set CUSTOM_QUESTION_1-4 environment variables in Railway for permanent storage');
        }
        
    } catch (error) {
        console.error('❌ Error saving custom questions:', error);
    }
}

// Load custom questions on startup
loadCustomQuestions();

// Railway persistence setup endpoint
app.post('/api/setup-persistence', async (req, res) => {
    try {
        // Check environment variables for custom questions
        const envQuestions = {
            q1: process.env.CUSTOM_QUESTION_1,
            q2: process.env.CUSTOM_QUESTION_2,
            q3: process.env.CUSTOM_QUESTION_3,
            q4: process.env.CUSTOM_QUESTION_4
        };
        
        const hasEnvQuestions = envQuestions.q1 && envQuestions.q2 && envQuestions.q3 && envQuestions.q4;
        
        // Test local file write capability
        let canWriteFiles = false;
        try {
            const testFile = 'test-write.json';
            await fs.writeFile(testFile, JSON.stringify({ test: true, timestamp: new Date().toISOString() }));
            await fs.unlink(testFile);
            canWriteFiles = true;
        } catch (fileError) {
            canWriteFiles = false;
        }
        
        res.json({
            success: true,
            message: 'Railway persistence status checked',
            environment: {
                NODE_ENV: process.env.NODE_ENV,
                hasCustomQuestions: hasEnvQuestions,
                canWriteFiles: canWriteFiles
            },
            customQuestions: hasEnvQuestions ? envQuestions : 'Not set in environment variables',
            recommendations: {
                customQuestions: hasEnvQuestions ? 
                    '✅ Custom questions loaded from environment variables' : 
                    '⚠️ Set CUSTOM_QUESTION_1-4 environment variables for permanent storage',
                customerData: canWriteFiles ? 
                    '✅ Can write customer data to local files (temporary)' : 
                    '❌ Cannot write files - consider Railway PostgreSQL',
                nextSteps: hasEnvQuestions ? 
                    'All set! Your custom questions will persist across restarts.' :
                    'Add CUSTOM_QUESTION_1-4 environment variables in Railway dashboard'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Error checking Railway persistence',
            errorDetails: error.message
        });
    }
});

// Force save all data endpoint
app.post('/api/force-save', async (req, res) => {
    try {
        // Force save customers
        await customerDB.saveData();
        
        // Force save custom questions
        await saveCustomQuestions();
        
        res.json({
            success: true,
            message: 'All data saved successfully',
            customers: customerDB.customers.size,
            questions: global.customQuestions
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Initialize PostgreSQL database
let customerDB;

// Initialize database on startup
async function initializeApp() {
    try {
        console.log('🚀 Initializing AI SMS Chat application...');
        
        // Try to initialize PostgreSQL database
        try {
            await initializeDatabase();
            customerDB = new CustomerDatabase();
            
            // Load custom questions from database
            const dbQuestions = await customerDB.getCustomQuestions();
            if (Object.keys(dbQuestions).length > 0) {
                global.customQuestions = dbQuestions;
                console.log('📝 Loaded custom questions from database:', dbQuestions);
            }
            
            console.log('✅ PostgreSQL database connected successfully');
            console.log('🗄️ Database tables initialized: customers, customer_questions, chat_messages, custom_questions');
            
        } catch (dbError) {
            console.log('⚠️ PostgreSQL database not available, using fallback file system');
            console.log('💡 To enable database features, add a PostgreSQL database to your Railway project');
            
            // Initialize fallback file-based system
            customerDB = new FallbackCustomerDatabase();
            console.log('✅ Application initialized with file-based fallback');
        }
        
    } catch (error) {
        console.error('❌ Application initialization failed:', error);
        process.exit(1);
    }
}

// ========================================
// NEW CHAT SYSTEM API ENDPOINTS
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
            qualified: customer.qualified || false,
            question1: customer.question1 || { answered: false, answer: '' },
            question2: customer.question2 || { answered: false, answer: '' },
            question3: customer.question3 || { answered: false, answer: '' },
            question4: customer.question4 || { answered: false, answer: '' },
            unreadCount: customer.unreadCount || 0,
            lastMessage: customer.chatData?.messages?.length > 0 ? 
                customer.chatData.messages[customer.chatData.messages.length - 1] : null
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
            conversationStage: 'new'
        });
        
        res.json({
            success: true,
            lead: {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                source: customer.source,
                qualified: false,
                question1: { answered: false, answer: '' },
                question2: { answered: false, answer: '' },
                question3: { answered: false, answer: '' },
                question4: { answered: false, answer: '' },
                unreadCount: 0,
                lastMessage: null
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

// Get messages for a lead
app.get('/api/leads/:leadId/messages', async (req, res) => {
    try {
        const { leadId } = req.params;
        console.log(`🔍 Looking for lead with ID: ${leadId}`);
        
        // Try to find customer by phone number (since that's how they're stored)
        const customer = await customerDB.getCustomer(leadId);
        
        if (!customer) {
            console.log(`❌ Lead not found: ${leadId}`);
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        console.log(`✅ Found customer: ${customer.name} (${customer.phone})`);
        
        const messages = customer.chatData?.messages || [];
        
        // Convert to chat format
        const chatMessages = messages.map(msg => ({
            id: msg.messageId || `msg_${Date.now()}`,
            content: msg.message,
            sender: msg.sender === 'assistant' ? 'assistant' : 'customer',
            timestamp: msg.timestamp
        }));
        
        res.json({
            success: true,
            messages: chatMessages
        });
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
        const { leadId, content, aiEnabled } = req.body;
        console.log(`📤 Sending message to lead: ${leadId}`);
        console.log(`📤 Message content: ${content}`);
        
        if (!leadId || !content) {
            return res.status(400).json({
                success: false,
                error: 'Lead ID and content are required'
            });
        }
        
        const customer = await customerDB.getCustomer(leadId);
        if (!customer) {
            console.log(`❌ Customer not found for leadId: ${leadId}`);
            // Let's also try to get all customers to debug
            const allCustomers = await customerDB.getAllCustomers();
            console.log(`📋 Available customers:`, allCustomers.map(c => ({ id: c.id, phone: c.phone, name: c.name })));
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        console.log(`✅ Found customer: ${customer.name} (${customer.phone})`);
        
        // Add message to customer's chat data
        const messageData = {
            sender: 'assistant',
            message: content,
            timestamp: new Date().toISOString(),
            messageId: `msg_${Date.now()}_${Math.random()}`
        };
        
        const existingMessages = customer.chatData?.messages || [];
        const updatedMessages = [...existingMessages, messageData];
        
        // Update customer with new message
        await customerDB.updateCustomer(leadId, {
            chatData: {
                ...customer.chatData,
                messages: updatedMessages
            }
        });
        
        // Send SMS via Twilio
        const settings = {
            accountSid: process.env.TWILIO_ACCOUNT_SID,
            authToken: process.env.TWILIO_AUTH_TOKEN,
            fromNumber: process.env.TWILIO_FROM_NUMBER
        };
        
        if (settings.accountSid && settings.authToken && settings.fromNumber) {
            const client = twilio(settings.accountSid, settings.authToken);
            await client.messages.create({
                body: content,
                from: settings.fromNumber,
                to: customer.phone
            });
            
            console.log(`📤 SMS sent to ${customer.name} (${customer.phone}): "${content}"`);
        }
        
        let aiResponse = null;
        
        // Generate AI response if enabled
        if (aiEnabled && process.env.OPENAI_API_KEY) {
            try {
                aiResponse = await generateAIResponse(customer, content);
                
                if (aiResponse) {
                    // Add AI response to messages
                    const aiMessageData = {
                        sender: 'customer',
                        message: aiResponse,
                        timestamp: new Date().toISOString(),
                        messageId: `ai_${Date.now()}_${Math.random()}`
                    };
                    
                    const finalMessages = [...updatedMessages, aiMessageData];
                    
                    // Update customer with AI response
                    await customerDB.updateCustomer(leadId, {
                        chatData: {
                            ...customer.chatData,
                            messages: finalMessages
                        }
                    });
                    
                    console.log(`🤖 AI response generated for ${customer.name}: "${aiResponse}"`);
                }
            } catch (aiError) {
                console.error('Error generating AI response:', aiError);
            }
        }
        
        res.json({
            success: true,
            message: 'Message sent successfully',
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

// Check for new messages
app.get('/api/leads/:leadId/messages/check', async (req, res) => {
    try {
        const { leadId } = req.params;
        console.log(`🔍 Checking for new messages for lead: ${leadId}`);
        
        const customer = await customerDB.getCustomer(leadId);
        
        if (!customer) {
            console.log(`❌ Customer not found for leadId: ${leadId}`);
            return res.status(404).json({
                success: false,
                error: 'Lead not found'
            });
        }
        
        console.log(`✅ Found customer: ${customer.name} (${customer.phone})`);
        
        // Get the last message timestamp from the request (if provided)
        const lastCheckTime = req.query.lastCheck || new Date(Date.now() - 60000).toISOString(); // Default to 1 minute ago
        
        // Get messages from the customer's chat data
        const messages = customer.chatData?.messages || [];
        
        // Filter messages that are newer than the last check time and from customers (not assistant)
        const newMessages = messages.filter(msg => {
            const messageTime = new Date(msg.timestamp);
            const checkTime = new Date(lastCheckTime);
            return messageTime > checkTime && msg.sender === 'customer';
        });
        
        console.log(`📱 Found ${newMessages.length} new messages for ${customer.name}`);
        
        // Convert to chat format
        const chatMessages = newMessages.map(msg => ({
            id: msg.messageId || `msg_${Date.now()}`,
            content: msg.message,
            sender: 'customer',
            timestamp: msg.timestamp
        }));
        
        res.json({
            success: true,
            newMessages: chatMessages
        });
    } catch (error) {
        console.error('Error checking for new messages:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Generate AI response for lead qualification
async function generateAIResponse(customer, userMessage) {
    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        // Get custom questions
        const questions = global.customQuestions;
        
        // Check which questions are already answered
        const answeredQuestions = [];
        const unansweredQuestions = [];
        
        ['question1', 'question2', 'question3', 'question4'].forEach((q, index) => {
            if (customer[q]?.answered) {
                answeredQuestions.push(`${questions[`q${index + 1}`]}: ${customer[q].answer}`);
            } else {
                unansweredQuestions.push(questions[`q${index + 1}`]);
            }
        });
        
        // Build context for AI
        let context = `You are a sales assistant helping to qualify leads for an equine stable business. 
        
Customer: ${customer.name} (${customer.phone})
Email: ${customer.email || 'Not provided'}

Already answered questions:
${answeredQuestions.length > 0 ? answeredQuestions.join('\n') : 'None yet'}

Remaining questions to ask:
${unansweredQuestions.length > 0 ? unansweredQuestions.join('\n') : 'All questions answered - customer is qualified!'}

Customer's latest message: "${userMessage}"

Your task:
1. If there are unanswered questions, naturally work them into the conversation
2. Be friendly, professional, and helpful
3. Keep responses concise (under 160 characters for SMS)
4. If all questions are answered, congratulate them and mention next steps
5. Don't repeat questions that have already been answered

Respond naturally to their message while working toward qualification.`;

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: context },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 150,
            temperature: 0.7
        });
        
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error('Error generating AI response:', error);
        return null;
    }
}

// Start the application
initializeApp().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 AI SMS Chat server running on port ${PORT} - PostgreSQL Database v2.2.0 Ready!`);
        console.log(`💬 New Chat Interface: http://localhost:${PORT}/chat.html`);
    });
}).catch(error => {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
});

// Fallback file-based customer database for when PostgreSQL is not available
class FallbackCustomerDatabase {
    constructor() {
        this.customers = new Map();
        this.loadData();
    }

    async loadData() {
        try {
            const data = await fs.readFile('customers.json', 'utf8');
            const customerArray = JSON.parse(data);
            customerArray.forEach(customer => {
                this.customers.set(customer.phone, customer);
            });
            console.log(`📊 Loaded ${this.customers.size} customer records from file`);
        } catch (error) {
            console.log('📊 Starting with empty customer database (no data files found)');
        }
    }

    async saveData() {
        try {
            const customerArray = Array.from(this.customers.values());
            await fs.writeFile('customers.json', JSON.stringify(customerArray, null, 2));
            console.log(`📊 Saved ${customerArray.length} customer records to file`);
        } catch (error) {
            console.error('❌ Error saving customer data:', error);
        }
    }

    async createCustomer(data) {
        const customer = {
            id: `cust_${Date.now()}`,
            name: data.name || null,
            phone: data.phone,
            email: data.email || null,
            postcode: data.postcode || null,
            source: data.source || 'inbound_sms',
            sourceDetails: data.sourceDetails || {},
            
            // Default questions
            question1: { 
                question: global.customQuestions?.q1 || "How many horses do you currently have?", 
                answer: null,
                answered: false 
            },
            question2: { 
                question: global.customQuestions?.q2 || "What type of stable configuration interests you most?", 
                answer: null,
                answered: false 
            },
            question3: { 
                question: global.customQuestions?.q3 || "What's your budget range for this project?", 
                answer: null,
                answered: false 
            },
            question4: { 
                question: global.customQuestions?.q4 || "What's your ideal timeline for completion?", 
                answer: null,
                answered: false 
            },

            chatData: {},
            conversationStage: 'initial',
            lastContact: new Date().toISOString(),
            assistantThreadId: null,
            priority: 'medium',
            status: 'active',
            notes: [],
            created: new Date().toISOString()
        };

        this.customers.set(data.phone, customer);
        await this.saveData();
        return customer;
    }

    async updateCustomer(phone, updates) {
        const customer = this.customers.get(phone);
        if (customer) {
            Object.assign(customer, updates);
            customer.lastContact = new Date().toISOString();
            await this.saveData();
            return customer;
        }
        return null;
    }

    async getCustomer(phone) {
        return this.customers.get(phone);
    }

    async getAllCustomers() {
        return Array.from(this.customers.values());
    }

    async updateCustomQuestions(questions) {
        global.customQuestions = questions;
        await saveCustomQuestions();
        console.log('📝 Custom questions updated in file system');
    }

    async getCustomQuestions() {
        return global.customQuestions;
    }
}

// Enhanced OpenAI Assistant with CRM context
async function generateAssistantResponse(message, customer, openaiKey, assistantId) {
    try {
        // Get or create thread
        let threadId = customerDB.conversationThreads.get(customer.phone);
        
        if (!threadId) {
            const thread = await createOpenAIThread(openaiKey);
            threadId = thread.id;
            customerDB.conversationThreads.set(customer.phone, threadId);
            customerDB.updateCustomer(customer.phone, { assistantThreadId: threadId });
        }

        // Check for special offer mentions
        const lowerMessage = message.toLowerCase();
        const isAskingAboutOffers = lowerMessage.includes('offer') || 
                                   lowerMessage.includes('special') || 
                                   lowerMessage.includes('deal') || 
                                   lowerMessage.includes('discount') || 
                                   lowerMessage.includes('promotion') ||
                                   lowerMessage.includes('sale');

        // Create enhanced context for assistant
        let customerContext = `
Customer Profile:
- Name: ${customer.name || 'Unknown'}
- Phone: ${customer.phone}
- Email: ${customer.email || 'Not provided'}
- Postcode: ${customer.postcode || 'Not provided'}
- Source: ${customer.source}
- Conversation Stage: ${customer.conversationStage}

Questions Status:
1. ${customer.question1.question} - ${customer.question1.answered ? customer.question1.answer : 'NOT ANSWERED'}
2. ${customer.question2.question} - ${customer.question2.answered ? customer.question2.answer : 'NOT ANSWERED'}
3. ${customer.question3.question} - ${customer.question3.answered ? customer.question3.answer : 'NOT ANSWERED'}
4. ${customer.question4.question} - ${customer.question4.answered ? customer.question4.answer : 'NOT ANSWERED'}

Chat Data Collected: ${JSON.stringify(customer.chatData)}

Current Message: "${message}"

Please respond naturally while trying to collect any missing information. If this appears to answer one of the questions above, note it in your response.
        `;

        // Add special offer information if customer is asking about offers and we have an active offer
        if (isAskingAboutOffers && specialOffer && specialOffer.active) {
            const today = new Date();
            const expiryDate = new Date(specialOffer.expiry);
            
            if (expiryDate > today) {
                customerContext += `

SPECIAL OFFER AVAILABLE:
- Title: ${specialOffer.title}
- Description: ${specialOffer.description}
- Discount/Details: ${specialOffer.discount}
- Expires: ${expiryDate.toLocaleDateString()}
- Contact: ${specialOffer.contact}

IMPORTANT: If the customer is asking about offers, deals, discounts, or specials, make sure to mention this special offer in your response. Be enthusiastic but professional about the offer.
                `;
            }
        }

        // Add context message to thread
        await addMessageToThread(openaiKey, threadId, customerContext + "\n\nCustomer message: " + message);
        
        // Run assistant
        const run = await runAssistant(openaiKey, threadId, assistantId);
        await waitForRunCompletion(openaiKey, threadId, run.id);
        const response = await getLatestAssistantMessage(openaiKey, threadId, run.id);

        // Extract any information from the conversation
        customerDB.extractInfoFromChat(message, customer);

        // Try to match answers to questions
        
        // Question 1: Horses (look for numbers)
        if (!customer.question1.answered && /\d+/.test(message) && 
            (lowerMessage.includes('horse') || lowerMessage.includes('have'))) {
            customerDB.updateCustomer(customer.phone, {
                question1: { ...customer.question1, answer: message, answered: true }
            });
        }
        
        // Question 2: Stable type (look for stable-related keywords)
        if (!customer.question2.answered && 
            (lowerMessage.includes('stable') || lowerMessage.includes('stall') || 
             lowerMessage.includes('individual') || lowerMessage.includes('group'))) {
            customerDB.updateCustomer(customer.phone, {
                question2: { ...customer.question2, answer: message, answered: true }
            });
        }
        
        // Question 3: Budget (look for money-related keywords)
        if (!customer.question3.answered && 
            (lowerMessage.includes('budget') || lowerMessage.includes('£') || 
             lowerMessage.includes('pound') || lowerMessage.includes('cost') ||
             /\d+/.test(message))) {
            customerDB.updateCustomer(customer.phone, {
                question3: { ...customer.question3, answer: message, answered: true }
            });
        }
        
        // Question 4: Timeline (look for time-related keywords)
        if (!customer.question4.answered && 
            (lowerMessage.includes('timeline') || lowerMessage.includes('when') || 
             lowerMessage.includes('month') || lowerMessage.includes('week') ||
             lowerMessage.includes('urgent') || lowerMessage.includes('soon'))) {
            customerDB.updateCustomer(customer.phone, {
                question4: { ...customer.question4, answer: message, answered: true }
            });
        }
        
        // Check if all questions are answered
        const allQuestionsAnswered = customer.question1.answered && 
                                   customer.question2.answered && 
                                   customer.question3.answered && 
                                   customer.question4.answered;
        
        if (allQuestionsAnswered && customer.conversationStage !== 'completed') {
            // Close the conversation
            customerDB.updateCustomer(customer.phone, {
                conversationStage: 'completed',
                lastContact: new Date().toISOString()
            });
            
            // Send completion message
            const completionMessage = `Thank you for providing all the information! 

Here's what you've told us:
• Horses: ${customer.question1.answer}
• Stable type: ${customer.question2.answer}
• Budget: ${customer.question3.answer}
• Timeline: ${customer.question4.answer}

Our team will review your requirements and contact you within 24 hours with a detailed proposal.

Thank you for your interest in our stable services! 🐎`;

            // Send completion message
            const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            if (twilioClient) {
                await twilioClient.messages.create({
                    body: completionMessage,
                    from: To,
                    to: From
                });
                
                console.log(`✅ Conversation completed for customer ${customer.id}`);
                return; // Don't send the regular AI response
            }
        }

        return response;

    } catch (error) {
        console.error('❌ Assistant error:', error);
        throw error;
    }
}

// API Endpoints

// Lead import from Facebook/Gravity Forms
app.post('/api/import-lead', async (req, res) => {
    try {
        const { name, phone, email, postcode, source, sourceDetails, customData } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }

        const normalizedPhone = normalizePhoneNumber(phone);
        
        // Check if customer exists
        let customer = await customerDB.getCustomer(normalizedPhone);
        
        if (customer) {
            // Update existing customer
            const updates = { name, email, postcode };
            if (customData) {
                updates.chatData = { ...customer.chatData, ...customData };
            }
            customer = await customerDB.updateCustomer(normalizedPhone, updates);
        } else {
            // Create new customer
            customer = await customerDB.createCustomer({
                name,
                phone: normalizedPhone,
                email,
                postcode,
                source,
                sourceDetails,
                ...customData
            });
        }

        console.log(`📊 Lead imported: ${name} (${normalizedPhone}) from ${source}`);

        res.json({
            success: true,
            customer: customer,
            message: 'Lead imported successfully'
        });

    } catch (error) {
        console.error('❌ Lead import error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Send SMS with automatic customer creation
app.post('/api/send-sms', async (req, res) => {
    try {
        const { to, message, accountSid, authToken, from } = req.body;

        if (!to || !message || !accountSid || !authToken || !from) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const normalizedPhone = normalizePhoneNumber(to);
        
        // Get or create customer
        let customer = customerDB.getCustomer(normalizedPhone);
        if (!customer) {
            customer = customerDB.createCustomer({
                phone: normalizedPhone,
                source: 'outbound_sms'
            });
        }

        // Send SMS
        const client = twilio(accountSid, authToken);
        const smsResponse = await client.messages.create({
            body: message,
            from: from,
            to: to
        });

        // Update customer
        await customerDB.updateCustomer(normalizedPhone, {
            conversationStage: 'engaged'
        });

        console.log(`📤 SMS sent to customer ${customer.id}: "${message}"`);

        res.json({
            success: true,
            message: 'SMS sent successfully',
            customer: customer,
            data: {
                id: smsResponse.sid,
                to,
                from,
                body: message,
                status: smsResponse.status
            }
        });

    } catch (error) {
        console.error('❌ SMS send error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Enhanced webhook with customer management
app.post('/webhook/sms', async (req, res) => {
    try {
        const { Body, From, To, MessageSid } = req.body;
        
        console.log(`📥 Incoming SMS from ${From}: "${Body}"`);
        console.log(`📥 Full webhook payload:`, req.body);
        
        const normalizedPhone = normalizePhoneNumber(From);
        console.log(`📥 Normalized phone: ${normalizedPhone}`);
        
        // Get or create customer first
        let customer = await customerDB.getCustomer(normalizedPhone);
        console.log(`📥 Existing customer found:`, customer ? 'Yes' : 'No');
        
        if (!customer) {
            console.log(`📥 Creating new customer for phone: ${normalizedPhone}`);
            customer = await customerDB.createCustomer({
                phone: normalizedPhone,
                source: 'inbound_sms'
            });
            console.log(`📥 New customer created:`, customer);
        } else {
            console.log(`📥 Using existing customer:`, customer.id);
        }

        // Check if we've already processed this message (prevent duplicates)
        const existingMessages = customer?.chatData?.messages || [];
        const messageAlreadyExists = existingMessages.some(msg => msg.messageId === MessageSid);
        
        if (messageAlreadyExists) {
            console.log(`📥 Message ${MessageSid} already processed - skipping to prevent duplicates`);
            return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }

        // Rate limiting: Check if we've sent a message to this customer in the last 30 seconds
        const recentMessages = existingMessages.filter(msg => {
            const messageTime = new Date(msg.timestamp);
            const now = new Date();
            const timeDiff = (now - messageTime) / 1000; // seconds
            return timeDiff < 30 && msg.sender === 'assistant';
        });
        
        if (recentMessages.length > 0) {
            console.log(`📥 Rate limiting: Customer ${normalizedPhone} received a message less than 30 seconds ago - skipping to prevent spam`);
            return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }

        // Generate AI response with customer context (only if AI is enabled)
        const assistantId = process.env.OPENAI_ASSISTANT_ID;
        const openaiKey = process.env.OPENAI_API_KEY;
        
        if (assistantId && openaiKey && aiSettings.aiEnabled) {
            try {
                const aiResponse = await generateAssistantResponse(
                    Body, 
                    customer, 
                    openaiKey, 
                    assistantId
                );
                
                // Send response
                const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                if (twilioClient) {
                    const sentMessage = await twilioClient.messages.create({
                        body: aiResponse,
                        from: To,
                        to: From
                    });
                    
                    console.log(`🤖 Auto-replied to customer ${customer.id}: "${aiResponse}"`);
                    
                    // Store AI response message
                    const aiMessageData = {
                        sender: 'assistant',
                        message: aiResponse,
                        timestamp: new Date().toISOString(),
                        messageId: sentMessage.sid
                    };
                    
                    // Add AI response to messages
                    const allMessages = [...updatedMessages, aiMessageData];
                    
                    // Update customer with both messages
                    await customerDB.updateCustomer(normalizedPhone, {
                        conversationStage: 'active',
                        chatData: {
                            ...customer.chatData,
                            messages: allMessages
                        }
                    });
                }
            } catch (error) {
                console.error('❌ Error generating AI response:', error);
            }
        } else if (!aiSettings.aiEnabled) {
            console.log(`🚫 AI responses disabled - not replying to ${From}`);
        } else {
            console.log(`⚠️ AI credentials missing - not replying to ${From}`);
        }

        // Store conversation message in customer's chatData (if not already stored by AI response)
        if (!aiSettings.aiEnabled || !assistantId || !openaiKey) {
            const messageData = {
                sender: 'customer',
                message: Body,
                timestamp: new Date().toISOString(),
                messageId: MessageSid
            };

            // Get existing messages or create new array
            const existingMessages = customer.chatData?.messages || [];
            const updatedMessages = [...existingMessages, messageData];

            // Update conversation stage and store message
            await customerDB.updateCustomer(normalizedPhone, {
                conversationStage: 'active',
                chatData: {
                    ...customer.chatData,
                    messages: updatedMessages
                }
            });
        }
        
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Get recent messages from Twilio
app.get('/api/messages', async (req, res) => {
    try {
        const { accountSid, authToken } = req.query;
        
        if (!accountSid || !authToken) {
            return res.status(400).json({
                success: false,
                error: 'Account SID and Auth Token are required'
            });
        }

        const client = twilio(accountSid, authToken);
        
        // Fetch recent messages (last 24 hours)
        const messages = await client.messages.list({
            limit: 50,
            dateSentAfter: new Date(Date.now() - 24 * 60 * 60 * 1000)
        });

        const formattedMessages = messages.map(msg => ({
            id: msg.sid,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            direction: msg.direction,
            status: msg.status,
            dateSent: msg.dateSent,
            dateCreated: msg.dateCreated
        }));

        res.json({
            success: true,
            messages: formattedMessages,
            total: formattedMessages.length
        });

    } catch (error) {
        console.error('❌ Error fetching messages:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Customer management endpoints
app.get('/api/customers', async (req, res) => {
    try {
        const customers = await customerDB.getAllCustomers();
        res.json({
            success: true,
            customers: customers,
            total: customers.length
        });
    } catch (error) {
        console.error('Error getting customers:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/customers/:phone', async (req, res) => {
    try {
        const customer = await customerDB.getCustomer(normalizePhoneNumber(req.params.phone));
        if (customer) {
            res.json({ success: true, customer });
        } else {
            res.status(404).json({ success: false, error: 'Customer not found' });
        }
    } catch (error) {
        console.error('Error getting customer:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.put('/api/customers/:phone', async (req, res) => {
    try {
        const customer = await customerDB.updateCustomer(normalizePhoneNumber(req.params.phone), req.body);
        if (customer) {
            res.json({ success: true, customer });
        } else {
            res.status(404).json({ success: false, error: 'Customer not found' });
        }
    } catch (error) {
        console.error('Error updating customer:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.delete('/api/customers/:phone', (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        const deleted = customerDB.deleteCustomer(phone);
        
        if (deleted) {
            res.json({ success: true, message: 'Customer deleted successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Customer not found' });
        }
    } catch (error) {
        console.error('Error deleting customer:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/customers/export', (req, res) => {
    try {
        const customers = customerDB.getAllCustomers();
        
        // Filter customers ready for CRM export (complete profiles)
        const exportReadyCustomers = customers.filter(customer => {
            const hasBasicInfo = customer.name && customer.email;
            const hasAllAnswers = customer.question1.answered && customer.question2.answered && 
                                customer.question3.answered && customer.question4.answered;
            return hasBasicInfo && hasAllAnswers;
        });
        
        console.log(`Exporting ${exportReadyCustomers.length} customers to CRM`);
        
        res.json({
            success: true,
            message: `Exported ${exportReadyCustomers.length} customers to CRM`,
            customers: exportReadyCustomers,
            total: exportReadyCustomers.length
        });
        
    } catch (error) {
        console.error('Error exporting customers:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

app.get('/api/customers/export/csv', (req, res) => {
    try {
        const customers = customerDB.getAllCustomers();
        
        // Create CSV header
        const csvHeader = 'Name,Phone,Email,Postcode,Source,Question1,Answer1,Question2,Answer2,Question3,Answer3,Question4,Answer4,Created,LastContact,Status\n';
        
        // Create CSV rows
        const csvRows = customers.map(customer => {
            const row = [
                `"${customer.name || ''}"`,
                `"${customer.phone}"`,
                `"${customer.email || ''}"`,
                `"${customer.postcode || ''}"`,
                `"${customer.source}"`,
                `"${customer.question1.question}"`,
                `"${customer.question1.answer || ''}"`,
                `"${customer.question2.question}"`,
                `"${customer.question2.answer || ''}"`,
                `"${customer.question3.question}"`,
                `"${customer.question3.answer || ''}"`,
                `"${customer.question4.question}"`,
                `"${customer.question4.answer || ''}"`,
                `"${customer.created}"`,
                `"${customer.lastContact || ''}"`,
                `"${customer.conversationStage}"`
            ];
            return row.join(',');
        }).join('\n');
        
        const csvContent = csvHeader + csvRows;
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="customers_${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csvContent);
        
    } catch (error) {
        console.error('Error generating CSV:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Complete test endpoint: create customer + conversation + AI extraction
app.post('/api/customers/:phone/test-ai-extraction', async (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        
        // Step 1: Create customer
        const customer = customerDB.createCustomer({
            name: "Test Customer",
            phone: phone,
            email: "test@example.com",
            postcode: "CW1 1AA"
        });

        // Step 2: Add conversation data
        customerDB.updateCustomer(phone, {
            conversationStage: 'active',
            chatData: {
                messages: [
                    {
                        sender: 'customer',
                        message: 'Hi, I\'m interested in getting stables built for my horses',
                        timestamp: new Date(Date.now() - 3600000).toISOString(),
                        messageId: 'test_msg_1'
                    },
                    {
                        sender: 'assistant',
                        message: 'Great! How many horses do you currently have?',
                        timestamp: new Date(Date.now() - 3500000).toISOString(),
                        messageId: 'test_msg_2'
                    },
                    {
                        sender: 'customer',
                        message: 'I have 3 horses that need proper stabling',
                        timestamp: new Date(Date.now() - 3400000).toISOString(),
                        messageId: 'test_msg_3'
                    },
                    {
                        sender: 'assistant',
                        message: 'What type of stable configuration interests you most?',
                        timestamp: new Date(Date.now() - 3300000).toISOString(),
                        messageId: 'test_msg_4'
                    },
                    {
                        sender: 'customer',
                        message: 'I\'m looking for individual stables with American barn style, around £20,000 budget',
                        timestamp: new Date(Date.now() - 3200000).toISOString(),
                        messageId: 'test_msg_5'
                    },
                    {
                        sender: 'assistant',
                        message: 'Perfect! When do you need the stables completed?',
                        timestamp: new Date(Date.now() - 3100000).toISOString(),
                        messageId: 'test_msg_6'
                    },
                    {
                        sender: 'customer',
                        message: 'I need them ready by spring next year, so around 6 months from now',
                        timestamp: new Date(Date.now() - 3000000).toISOString(),
                        messageId: 'test_msg_7'
                    }
                ]
            }
        });

        // Step 3: Test AI extraction
        const updatedCustomer = customerDB.getCustomer(phone);
        if (!updatedCustomer || !updatedCustomer.chatData?.messages) {
            return res.status(500).json({
                success: false,
                error: 'Failed to create customer with conversation data'
            });
        }

        const conversationHistory = updatedCustomer.chatData.messages;
        const conversationText = conversationHistory.map(msg => 
            `${msg.sender}: ${msg.message}`
        ).join('\n');

        // Get current questions
        const questions = {
            q1: global.customQuestions?.q1 || "How many horses do you currently have?",
            q2: global.customQuestions?.q2 || "What type of stable configuration interests you most?",
            q3: global.customQuestions?.q3 || "What's your budget range for this project?",
            q4: global.customQuestions?.q4 || "What's your ideal timeline for completion?"
        };

        // Use OpenAI to extract answers
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
            return res.status(500).json({
                success: false,
                error: 'OpenAI API key not configured'
            });
        }

        const extractionPrompt = `You are an AI assistant that extracts specific information from customer conversations.

CONVERSATION:
${conversationText}

QUESTIONS TO ANSWER:
1. ${questions.q1}
2. ${questions.q2}
3. ${questions.q3}
4. ${questions.q4}

Please analyze the conversation and extract the best answers to each question. Look for:
- Direct answers to the questions
- Implied answers based on context
- Numbers, amounts, timeframes, preferences mentioned
- Any relevant information that could answer these questions

Return your response as a JSON object with this exact format:
{
  "question1": {"answer": "extracted answer or null", "answered": true/false},
  "question2": {"answer": "extracted answer or null", "answered": true/false},
  "question3": {"answer": "extracted answer or null", "answered": true/false},
  "question4": {"answer": "extracted answer or null", "answered": true/false}
}`;

        const openai = new OpenAI({ apiKey: openaiKey });
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: extractionPrompt }],
            temperature: 0.1
        });

        const aiResponse = completion.choices[0].message.content;
        console.log(`🤖 AI Response:`, aiResponse);

        let extractedAnswers;
        try {
            extractedAnswers = JSON.parse(aiResponse);
        } catch (parseError) {
            console.error('❌ Failed to parse AI response:', parseError);
            return res.status(500).json({
                success: false,
                error: 'Failed to parse AI response'
            });
        }

        // Update customer with extracted answers
        const updates = {
            question1: {
                question: questions.q1,
                answer: extractedAnswers.question1?.answer || null,
                answered: extractedAnswers.question1?.answered || false
            },
            question2: {
                question: questions.q2,
                answer: extractedAnswers.question2?.answer || null,
                answered: extractedAnswers.question2?.answered || false
            },
            question3: {
                question: questions.q3,
                answer: extractedAnswers.question3?.answer || null,
                answered: extractedAnswers.question3?.answered || false
            },
            question4: {
                question: questions.q4,
                answer: extractedAnswers.question4?.answer || null,
                answered: extractedAnswers.question4?.answered || false
            }
        };

        const finalCustomer = customerDB.updateCustomer(phone, updates);

        res.json({
            success: true,
            message: 'Complete AI extraction test completed successfully',
            customer: finalCustomer,
            aiResponse: aiResponse,
            extractedAnswers: extractedAnswers
        });

    } catch (error) {
        console.error('Complete AI extraction test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Simple test endpoint to create a basic customer
app.post('/api/customers/:phone/create-basic-customer', (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        
        // Create a basic customer
        const customer = customerDB.createCustomer({
            name: "Test Customer",
            phone: phone,
            email: "test@example.com",
            postcode: "CW1 1AA"
        });

        res.json({
            success: true,
            message: 'Basic test customer created successfully',
            customer: customer
        });
    } catch (error) {
        console.error('Create basic customer endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test endpoint to create a test customer with sample conversation data
app.post('/api/customers/:phone/create-test-customer', (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        

        // Create the customer using the proper method
        const createdCustomer = customerDB.createCustomer({
            name: "Test Customer",
            phone: phone,
            email: "test@example.com",
            postcode: "CW1 1AA"
        });

        // Update the customer with conversation data and custom questions
        customerDB.updateCustomer(phone, {
            conversationStage: 'active',
            chatData: {
                messages: [
                    {
                        sender: 'customer',
                        message: 'Hi, I\'m interested in getting stables built for my horses',
                        timestamp: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
                        messageId: 'test_msg_1'
                    },
                    {
                        sender: 'assistant',
                        message: 'Great! How many horses do you currently have?',
                        timestamp: new Date(Date.now() - 3500000).toISOString(),
                        messageId: 'test_msg_2'
                    },
                    {
                        sender: 'customer',
                        message: 'I have 3 horses that need proper stabling',
                        timestamp: new Date(Date.now() - 3400000).toISOString(),
                        messageId: 'test_msg_3'
                    },
                    {
                        sender: 'assistant',
                        message: 'What type of stable configuration interests you most?',
                        timestamp: new Date(Date.now() - 3300000).toISOString(),
                        messageId: 'test_msg_4'
                    },
                    {
                        sender: 'customer',
                        message: 'I\'m looking for individual stables with American barn style, around £20,000 budget',
                        timestamp: new Date(Date.now() - 3200000).toISOString(),
                        messageId: 'test_msg_5'
                    },
                    {
                        sender: 'assistant',
                        message: 'Perfect! When do you need the stables completed?',
                        timestamp: new Date(Date.now() - 3100000).toISOString(),
                        messageId: 'test_msg_6'
                    },
                    {
                        sender: 'customer',
                        message: 'I need them ready by spring next year, so around 6 months from now',
                        timestamp: new Date(Date.now() - 3000000).toISOString(),
                        messageId: 'test_msg_7'
                    }
                ]
            }
        });

        // Get the final customer data
        const finalCustomer = customerDB.getCustomer(phone);

        res.json({
            success: true,
            message: 'Test customer created successfully with conversation data',
            customer: finalCustomer
        });
    } catch (error) {
        console.error('Create test customer endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test endpoint to add sample conversation data
app.post('/api/customers/:phone/add-test-conversation', (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        const customer = customerDB.getCustomer(phone);
        
        if (!customer) {
            return res.status(404).json({
                success: false,
                error: 'Customer not found'
            });
        }

        // Add sample conversation data that matches the custom questions
        const testMessages = [
            {
                sender: 'customer',
                message: 'Hi, I need a new building for my business',
                timestamp: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
                messageId: 'test_msg_1'
            },
            {
                sender: 'assistant',
                message: 'Great! What type of building do you require?',
                timestamp: new Date(Date.now() - 3500000).toISOString(),
                messageId: 'test_msg_2'
            },
            {
                sender: 'customer',
                message: 'I need a warehouse building for storage, around 5000 sq ft',
                timestamp: new Date(Date.now() - 3400000).toISOString(),
                messageId: 'test_msg_3'
            },
            {
                sender: 'assistant',
                message: 'How soon do you need your building?',
                timestamp: new Date(Date.now() - 3300000).toISOString(),
                messageId: 'test_msg_4'
            },
            {
                sender: 'customer',
                message: 'I need it completed within 3 months, by the end of March',
                timestamp: new Date(Date.now() - 3200000).toISOString(),
                messageId: 'test_msg_5'
            },
            {
                sender: 'assistant',
                message: 'Do you need the building to be mobile?',
                timestamp: new Date(Date.now() - 3100000).toISOString(),
                messageId: 'test_msg_6'
            },
            {
                sender: 'customer',
                message: 'No, it will be a permanent structure on my property',
                timestamp: new Date(Date.now() - 3000000).toISOString(),
                messageId: 'test_msg_7'
            },
            {
                sender: 'assistant',
                message: 'How do you want me to respond, email or phone?',
                timestamp: new Date(Date.now() - 2900000).toISOString(),
                messageId: 'test_msg_8'
            },
            {
                sender: 'customer',
                message: 'Please email me the details and quote',
                timestamp: new Date(Date.now() - 2800000).toISOString(),
                messageId: 'test_msg_9'
            }
        ];

        // Update customer with test conversation data
        const updatedCustomer = customerDB.updateCustomer(phone, {
            chatData: {
                messages: testMessages
            }
        });

        res.json({
            success: true,
            message: 'Test conversation data added successfully',
            customer: updatedCustomer
        });
    } catch (error) {
        console.error('Test conversation endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Endpoint to sync all customers with current global questions
app.post('/api/customers/sync-questions', (req, res) => {
    try {
        const customers = customerDB.getAllCustomers();
        const currentQuestions = {
            q1: global.customQuestions?.q1 || "How many horses do you currently have?",
            q2: global.customQuestions?.q2 || "What type of stable configuration interests you most?",
            q3: global.customQuestions?.q3 || "What's your budget range for this project?",
            q4: global.customQuestions?.q4 || "What's your ideal timeline for completion?"
        };

        let updatedCount = 0;
        
        customers.forEach(customer => {
            // Check if customer's questions are different from current global questions
            const needsUpdate = 
                customer.question1.question !== currentQuestions.q1 ||
                customer.question2.question !== currentQuestions.q2 ||
                customer.question3.question !== currentQuestions.q3 ||
                customer.question4.question !== currentQuestions.q4;

            if (needsUpdate) {
                customerDB.updateCustomer(customer.phone, {
                    question1: {
                        question: currentQuestions.q1,
                        answer: customer.question1.answer,
                        answered: customer.question1.answered
                    },
                    question2: {
                        question: currentQuestions.q2,
                        answer: customer.question2.answer,
                        answered: customer.question2.answered
                    },
                    question3: {
                        question: currentQuestions.q3,
                        answer: customer.question3.answer,
                        answered: customer.question3.answered
                    },
                    question4: {
                        question: currentQuestions.q4,
                        answer: customer.question4.answer,
                        answered: customer.question4.answered
                    }
                });
                updatedCount++;
            }
        });

        res.json({
            success: true,
            message: `Synced questions for ${updatedCount} customers`,
            totalCustomers: customers.length,
            updatedCustomers: updatedCount,
            currentQuestions: currentQuestions
        });
    } catch (error) {
        console.error('Sync questions endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Debug endpoint to check customer conversation data
app.get('/api/customers/:phone/debug', (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        const customer = customerDB.getCustomer(phone);
        
        if (!customer) {
            return res.status(404).json({
                success: false,
                error: 'Customer not found'
            });
        }

        res.json({
            success: true,
            customer: {
                phone: customer.phone,
                name: customer.name,
                chatData: customer.chatData,
                conversationHistory: customer.chatData?.messages || [],
                questions: {
                    q1: customer.question1,
                    q2: customer.question2,
                    q3: customer.question3,
                    q4: customer.question4
                }
            }
        });
    } catch (error) {
        console.error('Debug endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// AI Answer Extraction Endpoint
app.post('/api/customers/:phone/extract-answers', async (req, res) => {
    try {
        const phone = normalizePhoneNumber(req.params.phone);
        const customer = await customerDB.getCustomer(phone);
        
        if (!customer) {
            return res.status(404).json({
                success: false,
                error: 'Customer not found'
            });
        }

        // Get conversation history from the customer's chat data and any stored messages
        const conversationHistory = customer.chatData?.messages || [];
        
        console.log(`🤖 AI Extraction for ${phone}:`);
        console.log(`📊 Customer chatData:`, customer.chatData);
        console.log(`💬 Conversation history length:`, conversationHistory.length);
        console.log(`💬 Conversation messages:`, conversationHistory);
        
        // If no conversation history, return current answers
        if (!conversationHistory || conversationHistory.length === 0) {
            console.log(`⚠️ No conversation history found for customer ${phone}`);
            return res.json({
                success: true,
                message: 'No conversation history found',
                extractedAnswers: {
                    question1: customer.question1,
                    question2: customer.question2,
                    question3: customer.question3,
                    question4: customer.question4
                }
            });
        }

        // Create conversation context for AI
        const conversationText = conversationHistory.map(msg => 
            `${msg.sender}: ${msg.message}`
        ).join('\n');

        console.log(`📝 Conversation text being sent to AI:`, conversationText);

        // Get the current questions from global settings (not customer's stored questions)
        const questions = {
            q1: global.customQuestions?.q1 || "How many horses do you currently have?",
            q2: global.customQuestions?.q2 || "What type of stable configuration interests you most?",
            q3: global.customQuestions?.q3 || "What's your budget range for this project?",
            q4: global.customQuestions?.q4 || "What's your ideal timeline for completion?"
        };

        console.log(`❓ Questions being analyzed (from global settings):`, questions);
        console.log(`❓ Customer's stored questions:`, {
            q1: customer.question1.question,
            q2: customer.question2.question,
            q3: customer.question3.question,
            q4: customer.question4.question
        });

        // Use OpenAI to extract answers
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
            return res.status(500).json({
                success: false,
                error: 'OpenAI API key not configured'
            });
        }

        const extractionPrompt = `
You are analyzing a customer conversation to extract specific answers to predefined questions.

CONVERSATION:
${conversationText}

QUESTIONS TO ANSWER:
1. ${questions.q1}
2. ${questions.q2}
3. ${questions.q3}
4. ${questions.q4}

Please analyze the conversation and extract the best answers to each question. Look for:
- Direct answers to the questions
- Implied answers based on context
- Numbers, amounts, timeframes, preferences mentioned
- Any relevant information that could answer these questions

If an answer is not clearly provided in the conversation, return null for that question.

Respond with a JSON object in this exact format:
{
    "question1": {
        "answer": "extracted answer or null",
        "answered": true/false
    },
    "question2": {
        "answer": "extracted answer or null", 
        "answered": true/false
    },
    "question3": {
        "answer": "extracted answer or null",
        "answered": true/false
    },
    "question4": {
        "answer": "extracted answer or null",
        "answered": true/false
    }
}

Only return the JSON object, no other text.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert at analyzing conversations and extracting specific information. Always respond with valid JSON only.'
                    },
                    {
                        role: 'user',
                        content: extractionPrompt
                    }
                ],
                temperature: 0.1,
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const aiResponse = await response.json();
        const extractedText = aiResponse.choices[0].message.content.trim();
        
        console.log(`🤖 AI Response:`, extractedText);
        
        // Parse the AI response
        let extractedAnswers;
        try {
            extractedAnswers = JSON.parse(extractedText);
            console.log(`✅ Parsed AI answers:`, extractedAnswers);
        } catch (parseError) {
            console.error('❌ Error parsing AI response:', parseError);
            console.error('❌ Raw AI response:', extractedText);
            return res.status(500).json({
                success: false,
                error: 'Failed to parse AI response'
            });
        }

        // Update customer with extracted answers and current questions
        const updates = {
            question1: {
                question: questions.q1, // Use current global questions
                answer: extractedAnswers.question1?.answer || customer.question1.answer,
                answered: extractedAnswers.question1?.answered || customer.question1.answered
            },
            question2: {
                question: questions.q2, // Use current global questions
                answer: extractedAnswers.question2?.answer || customer.question2.answer,
                answered: extractedAnswers.question2?.answered || customer.question2.answered
            },
            question3: {
                question: questions.q3, // Use current global questions
                answer: extractedAnswers.question3?.answer || customer.question3.answer,
                answered: extractedAnswers.question3?.answered || customer.question3.answered
            },
            question4: {
                question: questions.q4, // Use current global questions
                answer: extractedAnswers.question4?.answer || customer.question4.answer,
                answered: extractedAnswers.question4?.answered || customer.question4.answered
            }
        };

        const updatedCustomer = await customerDB.updateCustomer(phone, updates);

        console.log(`🤖 AI extracted answers for customer ${phone}`);

        res.json({
            success: true,
            message: 'Answers extracted successfully',
            customer: updatedCustomer,
            extractedAnswers: updates
        });

    } catch (error) {
        console.error('Error extracting answers:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current questions configuration
// Get questions configuration
app.get('/api/questions', (req, res) => {
    res.json({
        success: true,
        questions: global.customQuestions
    });
});

// Get questions configuration (legacy endpoint)
app.get('/api/configure-questions', (req, res) => {
    res.json({
        success: true,
        questions: global.customQuestions
    });
});

// Update questions configuration
app.post('/api/configure-questions', async (req, res) => {
    try {
        const { questions } = req.body;
        
        // Store the custom questions globally
        global.customQuestions = questions;
        
        // Save to database for persistence
        await customerDB.updateCustomQuestions(questions);
        
        console.log('Custom questions updated and saved to database:', questions);
        
        res.json({
            success: true,
            message: 'Questions configuration updated and saved to database',
            questions: questions
        });
    } catch (error) {
        console.error('Error updating questions:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update questions'
        });
    }
});

// Serve environment variables to frontend
app.get('/api/env', (req, res) => {
    res.json({
        TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
        TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
        TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        OPENAI_ASSISTANT_ID: process.env.OPENAI_ASSISTANT_ID || ''
    });
});

// Special Offer API endpoints
app.get('/api/special-offer', (req, res) => {
    res.json({
        success: true,
        offer: specialOffer
    });
});

app.post('/api/special-offer', (req, res) => {
    try {
        const offerData = req.body;
        
        // Validate required fields
        if (!offerData.title || !offerData.description || !offerData.expiry) {
            return res.status(400).json({
                success: false,
                error: 'Title, description, and expiry date are required'
            });
        }
        
        // Check if expiry date is in the future
        const expiryDate = new Date(offerData.expiry);
        const today = new Date();
        if (expiryDate <= today) {
            return res.status(400).json({
                success: false,
                error: 'Expiry date must be in the future'
            });
        }
        
        // Save the special offer
        specialOffer = {
            ...offerData,
            updated: new Date().toISOString()
        };
        
        console.log('🎯 Special offer updated:', specialOffer.title);
        
        res.json({
            success: true,
            message: 'Special offer saved successfully'
        });
        
    } catch (error) {
        console.error('Error saving special offer:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// AI Settings API endpoints
app.get('/api/ai-settings', (req, res) => {
    res.json({
        success: true,
        settings: aiSettings
    });
});

app.post('/api/ai-settings', (req, res) => {
    try {
        const { aiEnabled, testMode } = req.body;
        
        // Update AI settings
        aiSettings = {
            aiEnabled: aiEnabled !== undefined ? aiEnabled : aiSettings.aiEnabled,
            testMode: testMode !== undefined ? testMode : aiSettings.testMode,
            updated: new Date().toISOString()
        };
        
        console.log('🤖 AI settings updated:', aiSettings);
        
        res.json({
            success: true,
            message: 'AI settings saved successfully',
            settings: aiSettings
        });
        
    } catch (error) {
        console.error('Error saving AI settings:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Test endpoint to verify server is working
app.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Server is working!',
        timestamp: new Date().toISOString(),
        customers: customerDB.getAllCustomers().length
    });
});

// Serve main interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        customers: customerDB.customers.size,
        activeThreads: customerDB.conversationThreads.size
    });
});

// OpenAI Assistant Functions
async function createOpenAIThread(apiKey) {
    const response = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
        }
    });
    
    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
    }
    
    return await response.json();
}

async function addMessageToThread(apiKey, threadId, content) {
    const response = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
            role: 'user',
            content: content
        })
    });
    
    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
    }
    
    return await response.json();
}

async function runAssistant(apiKey, threadId, assistantId) {
    const response = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
            assistant_id: assistantId
        })
    });
    
    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
    }
    
    return await response.json();
}

async function waitForRunCompletion(apiKey, threadId, runId) {
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max wait
    
    while (attempts < maxAttempts) {
        const response = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'OpenAI-Beta': 'assistants=v2'
            }
        });
        
        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }
        
        const run = await response.json();
        
        if (run.status === 'completed') {
            return run;
        } else if (run.status === 'failed' || run.status === 'cancelled') {
            throw new Error(`Run ${run.status}: ${run.last_error?.message || 'Unknown error'}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
    }
    
    throw new Error('Run completion timeout');
}

async function getLatestAssistantMessage(apiKey, threadId, runId) {
    const response = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=1`, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'assistants=v2'
        }
    });
    
    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    const message = data.data[0];
    
    if (message && message.content && message.content[0] && message.content[0].text) {
        return message.content[0].text.value;
    }
    
    return "I'm sorry, I couldn't generate a response at this time.";
}

function normalizePhoneNumber(phone) {
    let normalized = phone.replace(/[^\d+]/g, '');
    if (!normalized.startsWith('+') && normalized.length === 10) {
        normalized = '+1' + normalized;
    } else if (!normalized.startsWith('+') && normalized.length === 11 && normalized.startsWith('44')) {
        normalized = '+' + normalized;
    }
    return normalized;
}

// Server startup is now handled in initializeApp()

// Test endpoint to verify deployment
app.get('/api/deployment-test', (req, res) => {
    res.json({
        success: true,
        version: '2.1.0',
        database: 'PostgreSQL',
        timestamp: new Date().toISOString(),
        message: 'PostgreSQL Database v2.1.0 is deployed and working!'
    });
});