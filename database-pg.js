// PostgreSQL Database for Lead Qualification System (Railway)
const { Pool } = require('pg');

// Initialize PostgreSQL connection
let pool;
let isPostgreSQL = false;

// Check if we're on Railway with PostgreSQL
if (process.env.DATABASE_URL) {
    try {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
        isPostgreSQL = true;
        console.log('🗄️ Using PostgreSQL database (Railway)');
    } catch (error) {
        console.error('❌ PostgreSQL connection failed:', error.message);
        isPostgreSQL = false;
    }
} else {
    console.log('⚠️ No DATABASE_URL found, falling back to SQLite');
}

// Initialize database schema
async function initializeDatabase() {
    if (!isPostgreSQL) {
        console.log('⚠️ PostgreSQL not available, using SQLite fallback');
        return;
    }
    
    console.log('🗄️ Initializing PostgreSQL database...');
    
    try {
        // Create leads table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(255),
                email VARCHAR(255),
                source VARCHAR(50) DEFAULT 'inbound_sms',
                status VARCHAR(50) DEFAULT 'new',
                progress INTEGER DEFAULT 0,
                qualified BOOLEAN DEFAULT FALSE,
                archived BOOLEAN DEFAULT FALSE,
                ai_paused BOOLEAN DEFAULT FALSE,
                post_qualification_response_sent BOOLEAN DEFAULT FALSE,
                answers JSONB,
                qualified_date TIMESTAMP,
                returning_customer BOOLEAN DEFAULT FALSE,
                times_qualified INTEGER DEFAULT 0,
                first_qualified_date TIMESTAMP,
                last_qualified_date TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_contact TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                sender VARCHAR(20) NOT NULL,
                content TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create settings table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create indexes
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
            CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived);
            CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
        `);
        
        // Add new columns if they don't exist (migration for existing databases)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='post_qualification_response_sent'
                ) THEN
                    ALTER TABLE leads ADD COLUMN post_qualification_response_sent BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='returning_customer'
                ) THEN
                    ALTER TABLE leads ADD COLUMN returning_customer BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='times_qualified'
                ) THEN
                    ALTER TABLE leads ADD COLUMN times_qualified INTEGER DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='first_qualified_date'
                ) THEN
                    ALTER TABLE leads ADD COLUMN first_qualified_date TIMESTAMP;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='last_qualified_date'
                ) THEN
                    ALTER TABLE leads ADD COLUMN last_qualified_date TIMESTAMP;
                END IF;
            END $$;
        `);
        
        console.log('✅ PostgreSQL database initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing PostgreSQL database:', error);
        throw error;
    }
}

// PostgreSQL LeadDatabase class
class LeadDatabase {
    // Create a new lead
    static async createLead(data) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                INSERT INTO leads (phone, name, email, source, status, progress, qualified, ai_paused, 
                                   post_qualification_response_sent, answers, returning_customer, times_qualified)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING *
            `, [
                data.phone,
                data.name,
                data.email,
                data.source || 'inbound_sms',
                data.status || 'new',
                data.progress || 0,
                data.qualified || false,
                data.ai_paused || false,
                data.post_qualification_response_sent || false,
                JSON.stringify(data.answers || {}),
                data.returning_customer || false,
                data.times_qualified || 0
            ]);
            
            const lead = result.rows[0];
            lead.answers = lead.answers || {};
            lead.qualified = Boolean(lead.qualified);
            lead.archived = Boolean(lead.archived);
            lead.ai_paused = Boolean(lead.ai_paused);
            
            console.log(`✅ Created lead with ID: ${lead.id}`);
            return lead;
        } catch (error) {
            console.error('❌ Error creating lead:', error);
            throw error;
        }
    }
    
    // Get lead by phone
    static async getLeadByPhone(phone) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT * FROM leads WHERE phone = $1 AND archived = FALSE
            `, [phone]);
            
            if (result.rows.length > 0) {
                const lead = result.rows[0];
                lead.answers = lead.answers || {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                lead.returning_customer = Boolean(lead.returning_customer);
                lead.post_qualification_response_sent = Boolean(lead.post_qualification_response_sent);
                return lead;
            }
            return null;
        } catch (error) {
            console.error('❌ Error getting lead by phone:', error);
            throw error;
        }
    }
    
    // Get lead by ID
    static async getLeadById(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT * FROM leads WHERE id = $1 AND archived = FALSE
            `, [id]);
            
            if (result.rows.length > 0) {
                const lead = result.rows[0];
                lead.answers = lead.answers || {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                lead.returning_customer = Boolean(lead.returning_customer);
                lead.post_qualification_response_sent = Boolean(lead.post_qualification_response_sent);
                return lead;
            }
            return null;
        } catch (error) {
            console.error('❌ Error getting lead by ID:', error);
            throw error;
        }
    }
    
    // Get all leads
    static async getAllLeads() {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT * FROM leads WHERE archived = FALSE ORDER BY last_contact DESC
            `);
            
            return result.rows.map(lead => {
                lead.answers = lead.answers || {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                lead.returning_customer = Boolean(lead.returning_customer);
                lead.post_qualification_response_sent = Boolean(lead.post_qualification_response_sent);
                return lead;
            });
        } catch (error) {
            console.error('❌ Error getting all leads:', error);
            throw error;
        }
    }
    
    // Update lead
    static async updateLead(id, data) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                UPDATE leads 
                SET name = $1, email = $2, status = $3, progress = $4, qualified = $5, 
                    ai_paused = $6, answers = $7, qualified_date = $8, 
                    post_qualification_response_sent = $9, returning_customer = $10, 
                    times_qualified = $11, first_qualified_date = $12, last_qualified_date = $13,
                    last_contact = CURRENT_TIMESTAMP
                WHERE id = $14
                RETURNING *
            `, [
                data.name,
                data.email,
                data.status,
                data.progress,
                data.qualified,
                data.ai_paused,
                JSON.stringify(data.answers || {}),
                data.qualifiedDate,
                data.post_qualification_response_sent,
                data.returning_customer,
                data.times_qualified,
                data.first_qualified_date,
                data.last_qualified_date,
                id
            ]);
            
            if (result.rows.length > 0) {
                const lead = result.rows[0];
                lead.answers = lead.answers || {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                
                console.log(`✅ Updated lead ID: ${id}`);
                return lead;
            }
            return null;
        } catch (error) {
            console.error('❌ Error updating lead:', error);
            throw error;
        }
    }
    
    // Create message
    static async createMessage(leadId, sender, content, timestamp = null) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const ts = timestamp || new Date().toISOString();
            
            const result = await pool.query(`
                INSERT INTO messages (lead_id, sender, content, timestamp)
                VALUES ($1, $2, $3, $4)
                RETURNING *
            `, [leadId, sender, content, ts]);
            
            return result.rows[0];
        } catch (error) {
            console.error('❌ Error creating message:', error);
            throw error;
        }
    }
    
    // Get messages by lead ID
    static async getMessagesByLeadId(leadId) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT * FROM messages WHERE lead_id = $1 ORDER BY timestamp ASC
            `, [leadId]);
            
            return result.rows;
        } catch (error) {
            console.error('❌ Error getting messages:', error);
            throw error;
        }
    }
    
    // Get custom questions
    static async getCustomQuestions() {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT value FROM settings WHERE key = 'custom_questions'
            `);
            
            if (result.rows.length > 0) {
                return JSON.parse(result.rows[0].value);
            }
            return [];
        } catch (error) {
            console.error('❌ Error getting custom questions:', error);
            return [];
        }
    }
    
    // Save custom questions
    static async saveCustomQuestions(questions) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                INSERT INTO settings (key, value, updated_at)
                VALUES ('custom_questions', $1, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
            `, [JSON.stringify(questions)]);
            
            console.log('✅ Custom questions saved to PostgreSQL');
        } catch (error) {
            console.error('❌ Error saving custom questions:', error);
            throw error;
        }
    }
    
    // Get assistant name
    static async getAssistantName() {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT value FROM settings WHERE key = 'assistant_name'
            `);
            
            if (result.rows.length > 0) {
                return result.rows[0].value;
            }
            return 'Oscar';
        } catch (error) {
            console.error('❌ Error getting assistant name:', error);
            return 'Oscar';
        }
    }
    
    // Save assistant name
    static async saveAssistantName(name) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                INSERT INTO settings (key, value, updated_at)
                VALUES ('assistant_name', $1, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
            `, [name]);
            
            console.log(`✅ Assistant name saved to PostgreSQL: ${name}`);
        } catch (error) {
            console.error('❌ Error saving assistant name:', error);
            throw error;
        }
    }
    
    // Check if customer exists (returns lead if exists, null if new)
    // Also checks for archived customers and restores them
    static async checkExistingCustomer(phone) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            // First check for active leads
            const lead = await this.getLeadByPhone(phone);
            if (lead) {
                console.log(`👤 Found existing customer: ${lead.name} (${lead.phone})`);
                console.log(`   Status: ${lead.status}, Progress: ${lead.progress}%`);
                return lead;
            }
            
            // Check for archived leads and restore them
            const archivedResult = await pool.query(`
                SELECT * FROM leads WHERE phone = $1 AND archived = TRUE
            `, [phone]);
            
            if (archivedResult.rows.length > 0) {
                const archivedLead = archivedResult.rows[0];
                archivedLead.answers = archivedLead.answers || {};
                archivedLead.qualified = Boolean(archivedLead.qualified);
                archivedLead.archived = Boolean(archivedLead.archived);
                archivedLead.ai_paused = Boolean(archivedLead.ai_paused);
                
                // Restore the archived lead
                await pool.query(`
                    UPDATE leads 
                    SET archived = FALSE, last_contact = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [archivedLead.id]);
                
                console.log(`🔄 Restored archived customer: ${archivedLead.name} (${archivedLead.phone})`);
                console.log(`   Status: ${archivedLead.status}, Progress: ${archivedLead.progress}%`);
                return archivedLead;
            }
            
            console.log(`🆕 New customer detected: ${phone}`);
            return null;
        } catch (error) {
            console.error('Error checking existing customer:', error);
            return null;
        }
    }
    
    // Update last contact time
    static async updateLastContact(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                UPDATE leads 
                SET last_contact = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [id]);
            return true;
        } catch (error) {
            console.error('Error updating last contact:', error);
            return false;
        }
    }
    
    // Get conversation history
    static async getConversationHistory(leadId) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT * FROM messages 
                WHERE lead_id = $1 
                ORDER BY created_at ASC
            `, [leadId]);
            return result.rows;
        } catch (error) {
            console.error('Error getting conversation history:', error);
            return [];
        }
    }
    
    // Delete lead
    static async deleteLead(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                UPDATE leads 
                SET archived = TRUE 
                WHERE id = $1
            `, [id]);
            return true;
        } catch (error) {
            console.error('Error deleting lead:', error);
            return false;
        }
    }
    
    // Pause AI
    static async pauseAI(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                UPDATE leads 
                SET ai_paused = TRUE 
                WHERE id = $1
            `, [id]);
            return true;
        } catch (error) {
            console.error('Error pausing AI:', error);
            return false;
        }
    }
    
    // Unpause AI
    static async unpauseAI(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                UPDATE leads 
                SET ai_paused = FALSE 
                WHERE id = $1
            `, [id]);
            return true;
        } catch (error) {
            console.error('Error unpausing AI:', error);
            return false;
        }
    }
}

module.exports = {
    pool,
    LeadDatabase,
    initializeDatabase,
    isPostgreSQL
};
