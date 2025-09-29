// CRM-Enhanced Equine SMS Server
const express = require('express');
const path = require('path');
const cors = require('cors');
const twilio = require('twilio');
const fs = require('fs').promises;

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

// Customer Database (In production, use proper database)
class CustomerDatabase {
    constructor() {
        this.customers = new Map(); // phone -> customer data
        this.conversationThreads = new Map(); // phone -> threadId
        this.loadData();
    }

    async loadData() {
        try {
            const data = await fs.readFile('customers.json', 'utf8');
            const customerArray = JSON.parse(data);
            customerArray.forEach(customer => {
                this.customers.set(customer.phone, customer);
                if (customer.assistantThreadId) {
                    this.conversationThreads.set(customer.phone, customer.assistantThreadId);
                }
            });
            console.log(`📊 Loaded ${this.customers.size} customer records`);
        } catch (error) {
            console.log('📊 Starting with empty customer database');
        }
    }

    async saveData() {
        try {
            const customerArray = Array.from(this.customers.values());
            await fs.writeFile('customers.json', JSON.stringify(customerArray, null, 2));
        } catch (error) {
            console.error('❌ Error saving customer data:', error);
        }
    }

    createCustomer(data) {
        const customer = {
            id: `cust_${Date.now()}`,
            name: data.name || null,
            phone: data.phone,
            email: data.email || null,
            postcode: data.postcode || null,
            source: data.source || 'inbound_sms',
            sourceDetails: data.sourceDetails || {},
            
            // Default questions (editable via admin)
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
        this.saveData();
        return customer;
    }

    updateCustomer(phone, updates) {
        const customer = this.customers.get(phone);
        if (customer) {
            Object.assign(customer, updates);
            customer.lastContact = new Date().toISOString();
            this.saveData();
        }
        return customer;
    }

    deleteCustomer(phone) {
        const customer = this.customers.get(phone);
        if (customer) {
            this.customers.delete(phone);
            this.conversationThreads.delete(phone);
            this.saveData();
            return true;
        }
        return false;
    }

    getCustomer(phone) {
        return this.customers.get(phone);
    }

    getAllCustomers() {
        return Array.from(this.customers.values());
    }

    extractInfoFromChat(message, customer) {
        const updates = {};
        
        // Extract common information patterns
        const patterns = {
            horses: /(\d+)\s*horses?/i,
            budget: /£?([\d,]+)(?:\s*-\s*£?([\d,]+))?/,
            timeline: /(spring|summer|autumn|winter|\d+\s*months?|\d+\s*weeks?)/i,
            acreage: /(\d+(?:\.\d+)?)\s*acres?/i,
            location: /([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})/i // UK postcode pattern
        };

        Object.entries(patterns).forEach(([key, pattern]) => {
            const match = message.match(pattern);
            if (match) {
                updates[key] = match[0];
            }
        });

        if (Object.keys(updates).length > 0) {
            customer.chatData = { ...customer.chatData, ...updates };
            this.updateCustomer(customer.phone, { chatData: customer.chatData });
        }

        return updates;
    }
}

// Initialize database
const customerDB = new CustomerDatabase();

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
app.post('/api/import-lead', (req, res) => {
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
        let customer = customerDB.getCustomer(normalizedPhone);
        
        if (customer) {
            // Update existing customer
            const updates = { name, email, postcode };
            if (customData) {
                updates.chatData = { ...customer.chatData, ...customData };
            }
            customer = customerDB.updateCustomer(normalizedPhone, updates);
        } else {
            // Create new customer
            customer = customerDB.createCustomer({
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
        customerDB.updateCustomer(normalizedPhone, {
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
        
        // Get or create customer
        let customer = customerDB.getCustomer(normalizedPhone);
        console.log(`📥 Existing customer found:`, customer ? 'Yes' : 'No');
        
        if (!customer) {
            console.log(`📥 Creating new customer for phone: ${normalizedPhone}`);
            customer = customerDB.createCustomer({
                phone: normalizedPhone,
                source: 'inbound_sms'
            });
            console.log(`📥 New customer created:`, customer);
        } else {
            console.log(`📥 Using existing customer:`, customer.id);
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
                    customerDB.updateCustomer(normalizedPhone, {
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
            customerDB.updateCustomer(normalizedPhone, {
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
app.get('/api/customers', (req, res) => {
    const customers = customerDB.getAllCustomers();
    res.json({
        success: true,
        customers: customers,
        total: customers.length
    });
});

app.get('/api/customers/:phone', (req, res) => {
    const customer = customerDB.getCustomer(normalizePhoneNumber(req.params.phone));
    if (customer) {
        res.json({ success: true, customer });
    } else {
        res.status(404).json({ success: false, error: 'Customer not found' });
    }
});

app.put('/api/customers/:phone', (req, res) => {
    const customer = customerDB.updateCustomer(normalizePhoneNumber(req.params.phone), req.body);
    if (customer) {
        res.json({ success: true, customer });
    } else {
        res.status(404).json({ success: false, error: 'Customer not found' });
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

        // Add sample conversation data
        const testMessages = [
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
        const customer = customerDB.getCustomer(phone);
        
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

        // Get the current questions
        const questions = {
            q1: customer.question1.question,
            q2: customer.question2.question,
            q3: customer.question3.question,
            q4: customer.question4.question
        };

        console.log(`❓ Questions being analyzed:`, questions);

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

        // Update customer with extracted answers
        const updates = {
            question1: {
                question: questions.q1,
                answer: extractedAnswers.question1?.answer || customer.question1.answer,
                answered: extractedAnswers.question1?.answered || customer.question1.answered
            },
            question2: {
                question: questions.q2,
                answer: extractedAnswers.question2?.answer || customer.question2.answer,
                answered: extractedAnswers.question2?.answered || customer.question2.answered
            },
            question3: {
                question: questions.q3,
                answer: extractedAnswers.question3?.answer || customer.question3.answer,
                answered: extractedAnswers.question3?.answered || customer.question3.answered
            },
            question4: {
                question: questions.q4,
                answer: extractedAnswers.question4?.answer || customer.question4.answer,
                answered: extractedAnswers.question4?.answered || customer.question4.answered
            }
        };

        const updatedCustomer = customerDB.updateCustomer(phone, updates);

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
app.get('/api/configure-questions', (req, res) => {
    res.json({
        success: true,
        questions: global.customQuestions
    });
});

// Update questions configuration
app.post('/api/configure-questions', (req, res) => {
    const { questions } = req.body;
    
    // Store the custom questions globally
    global.customQuestions = questions;
    
    console.log('Custom questions updated:', questions);
    
    res.json({
        success: true,
        message: 'Questions configuration updated',
        questions: questions
    });
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

// Start server
app.listen(PORT, () => {
    console.log('🚀 CRM-Integrated SMS System Started!');
    console.log(`📱 Interface: http://localhost:${PORT}`);
    console.log(`📊 Customer Database: ${customerDB.customers.size} records`);
    console.log(`🎯 Lead Import: POST /api/import-lead`);
});