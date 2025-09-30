const { Pool } = require('pg');

// Database connection configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database initialization
async function initializeDatabase() {
    try {
        console.log('🗄️ Initializing PostgreSQL database...');
        
        // Create customers table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(255),
                email VARCHAR(255),
                postcode VARCHAR(20),
                source VARCHAR(100) DEFAULT 'inbound_sms',
                source_details JSONB DEFAULT '{}',
                conversation_stage VARCHAR(50) DEFAULT 'initial',
                assistant_thread_id VARCHAR(255),
                priority VARCHAR(20) DEFAULT 'medium',
                status VARCHAR(20) DEFAULT 'active',
                notes JSONB DEFAULT '[]',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_contact TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create customer_questions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customer_questions (
                id SERIAL PRIMARY KEY,
                customer_phone VARCHAR(20) REFERENCES customers(phone) ON DELETE CASCADE,
                question_number INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                answer TEXT,
                answered BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(customer_phone, question_number)
            )
        `);
        
        // Create chat_messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                customer_phone VARCHAR(20) REFERENCES customers(phone) ON DELETE CASCADE,
                sender VARCHAR(20) NOT NULL,
                message TEXT NOT NULL,
                message_id VARCHAR(255),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create custom_questions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS custom_questions (
                id SERIAL PRIMARY KEY,
                question_number INTEGER UNIQUE NOT NULL,
                question_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Insert default custom questions if they don't exist
        await pool.query(`
            INSERT INTO custom_questions (question_number, question_text) 
            VALUES 
                (1, 'How many horses do you currently have?'),
                (2, 'What type of stable configuration interests you most?'),
                (3, 'What''s your budget range for this project?'),
                (4, 'What''s your ideal timeline for completion?')
            ON CONFLICT (question_number) DO NOTHING
        `);
        
        console.log('✅ Database initialized successfully');
        
    } catch (error) {
        console.error('❌ Database initialization error:', error);
        throw error;
    }
}

// Customer Database Class
class CustomerDatabase {
    constructor() {
        this.pool = pool;
    }

    // Create a new customer
    async createCustomer(data) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Insert customer
            const customerResult = await client.query(`
                INSERT INTO customers (phone, name, email, postcode, source, source_details, conversation_stage, priority, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *
            `, [
                data.phone,
                data.name || null,
                data.email || null,
                data.postcode || null,
                data.source || 'inbound_sms',
                JSON.stringify(data.sourceDetails || {}),
                'initial',
                'medium',
                'active'
            ]);
            
            const customer = customerResult.rows[0];
            
            // Insert default questions for this customer
            const questionsResult = await client.query(`
                SELECT question_number, question_text FROM custom_questions ORDER BY question_number
            `);
            
            for (const question of questionsResult.rows) {
                await client.query(`
                    INSERT INTO customer_questions (customer_phone, question_number, question_text, answer, answered)
                    VALUES ($1, $2, $3, $4, $5)
                `, [data.phone, question.question_number, question.question_text, null, false]);
            }
            
            await client.query('COMMIT');
            
            // Return customer with questions
            const customerWithQuestions = await this.getCustomer(data.phone);
            return customerWithQuestions;
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Get customer by phone
    async getCustomer(phone) {
        try {
            const customerResult = await this.pool.query(`
                SELECT * FROM customers WHERE phone = $1
            `, [phone]);
            
            if (customerResult.rows.length === 0) {
                return null;
            }
            
            const customer = customerResult.rows[0];
            
            // Get customer questions
            const questionsResult = await this.pool.query(`
                SELECT * FROM customer_questions 
                WHERE customer_phone = $1 
                ORDER BY question_number
            `, [phone]);
            
            // Format questions
            customer.question1 = questionsResult.rows.find(q => q.question_number === 1) || { question: '', answer: null, answered: false };
            customer.question2 = questionsResult.rows.find(q => q.question_number === 2) || { question: '', answer: null, answered: false };
            customer.question3 = questionsResult.rows.find(q => q.question_number === 3) || { question: '', answer: null, answered: false };
            customer.question4 = questionsResult.rows.find(q => q.question_number === 4) || { question: '', answer: null, answered: false };
            
            // Get chat messages
            const messagesResult = await this.pool.query(`
                SELECT * FROM chat_messages 
                WHERE customer_phone = $1 
                ORDER BY timestamp
            `, [phone]);
            
            customer.chatData = {
                messages: messagesResult.rows.map(msg => ({
                    sender: msg.sender,
                    message: msg.message,
                    timestamp: msg.timestamp.toISOString(),
                    messageId: msg.message_id
                }))
            };
            
            return customer;
            
        } catch (error) {
            console.error('Error getting customer:', error);
            throw error;
        }
    }

    // Update customer
    async updateCustomer(phone, updates) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Update customer basic info
            if (updates.name || updates.email || updates.postcode || updates.conversationStage) {
                await client.query(`
                    UPDATE customers 
                    SET name = COALESCE($2, name),
                        email = COALESCE($3, email),
                        postcode = COALESCE($4, postcode),
                        conversation_stage = COALESCE($5, conversation_stage),
                        last_contact = CURRENT_TIMESTAMP
                    WHERE phone = $1
                `, [phone, updates.name, updates.email, updates.postcode, updates.conversationStage]);
            }
            
            // Update questions if provided
            if (updates.question1 || updates.question2 || updates.question3 || updates.question4) {
                const questions = [updates.question1, updates.question2, updates.question3, updates.question4];
                
                for (let i = 0; i < questions.length; i++) {
                    const question = questions[i];
                    if (question) {
                        await client.query(`
                            UPDATE customer_questions 
                            SET question_text = COALESCE($3, question_text),
                                answer = COALESCE($4, answer),
                                answered = COALESCE($5, answered),
                                updated_at = CURRENT_TIMESTAMP
                            WHERE customer_phone = $1 AND question_number = $2
                        `, [phone, i + 1, question.question, question.answer, question.answered]);
                    }
                }
            }
            
            // Add chat messages if provided
            if (updates.chatData && updates.chatData.messages) {
                for (const message of updates.chatData.messages) {
                    await client.query(`
                        INSERT INTO chat_messages (customer_phone, sender, message, message_id, timestamp)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (message_id) DO NOTHING
                    `, [phone, message.sender, message.message, message.messageId, new Date(message.timestamp)]);
                }
            }
            
            await client.query('COMMIT');
            
            // Return updated customer
            return await this.getCustomer(phone);
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all customers
    async getAllCustomers() {
        try {
            const result = await this.pool.query(`
                SELECT DISTINCT phone FROM customers ORDER BY created_at DESC
            `);
            
            const customers = [];
            for (const row of result.rows) {
                const customer = await this.getCustomer(row.phone);
                if (customer) customers.push(customer);
            }
            
            return customers;
        } catch (error) {
            console.error('Error getting all customers:', error);
            throw error;
        }
    }

    // Update custom questions globally
    async updateCustomQuestions(questions) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            for (let i = 1; i <= 4; i++) {
                const questionKey = `q${i}`;
                if (questions[questionKey]) {
                    await client.query(`
                        UPDATE custom_questions 
                        SET question_text = $1, updated_at = CURRENT_TIMESTAMP
                        WHERE question_number = $2
                    `, [questions[questionKey], i]);
                }
            }
            
            await client.query('COMMIT');
            console.log('✅ Custom questions updated in database');
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Get custom questions
    async getCustomQuestions() {
        try {
            const result = await this.pool.query(`
                SELECT question_number, question_text FROM custom_questions ORDER BY question_number
            `);
            
            const questions = {};
            for (const row of result.rows) {
                questions[`q${row.question_number}`] = row.question_text;
            }
            
            return questions;
        } catch (error) {
            console.error('Error getting custom questions:', error);
            throw error;
        }
    }
}

module.exports = {
    pool,
    initializeDatabase,
    CustomerDatabase
};
