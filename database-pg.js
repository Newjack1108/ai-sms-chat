// PostgreSQL Database for Lead Qualification System (Railway)
const { Pool } = require('pg');

// Initialize PostgreSQL connection
let pool;
let isPostgreSQL = false;

// Prefer DATABASE_PRIVATE_URL on Railway (internal network, more reliable than public URL)
const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;

// Check if we're on Railway with PostgreSQL
if (connectionString) {
    try {
        pool = new Pool({
            connectionString,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 10,                          // Lower for Railway connection limits
            idleTimeoutMillis: 0,             // Disable - avoids "connection terminated" race after idle
            connectionTimeoutMillis: 30000    // 30s for cold starts / slow connections
        });
        
        // Handle pool errors
        pool.on('error', (err) => {
            console.error('❌ Unexpected PostgreSQL pool error:', err);
        });
        isPostgreSQL = true;
        console.log('🗄️ Using PostgreSQL database (Railway)', process.env.DATABASE_PRIVATE_URL ? '(private URL)' : '');
    } catch (error) {
        console.error('❌ PostgreSQL connection failed:', error.message);
        isPostgreSQL = false;
    }
} else {
    console.log('⚠️ No DATABASE_URL found, falling back to SQLite');
}

// Run a query with retries (for cold-start / DB-not-ready scenarios on Railway)
async function queryWithRetry(queryFn, maxRetries = 3, baseDelayMs = 5000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await queryFn();
        } catch (error) {
            lastError = error;
            const isRetryable = /timeout|terminated|ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(error.message) ||
                (error.cause && /timeout|terminated/i.test(String(error.cause)));
            if (attempt < maxRetries && isRetryable) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                console.warn(`⚠️ Database connection attempt ${attempt}/${maxRetries} failed (${error.message}), retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

// Initialize database schema
async function initializeDatabase() {
    if (!isPostgreSQL) {
        console.log('⚠️ PostgreSQL not available, using SQLite fallback');
        return;
    }
    
    console.log('🗄️ Initializing PostgreSQL database...');
    
    try {
        // Test connection with retry (handles Railway cold-start)
        await queryWithRetry(() => pool.query('SELECT 1'));
        console.log('✅ PostgreSQL connection verified');
        
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
                last_customer_message_time TIMESTAMP,
                reminder_1hr_sent BOOLEAN DEFAULT FALSE,
                reminder_24hr_sent BOOLEAN DEFAULT FALSE,
                reminder_48hr_sent BOOLEAN DEFAULT FALSE,
                webhook_timestamp TIMESTAMP,
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
        
        // Create lead_sources table for managing lead source mappings
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lead_sources (
                id SERIAL PRIMARY KEY,
                technical_id VARCHAR(50) UNIQUE NOT NULL,
                display_name VARCHAR(100) NOT NULL,
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Insert default lead sources if table is empty
        const sourceCountResult = await pool.query('SELECT COUNT(*) as count FROM lead_sources');
        if (parseInt(sourceCountResult.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO lead_sources (technical_id, display_name, active) VALUES
                ('inbound_sms', 'SMS Inbound', TRUE),
                ('manual', 'Manual Entry', TRUE),
                ('gravity_form_cs', 'CS Website Lead', TRUE),
                ('gravity_form_csgb', 'CSGB Website Lead', TRUE),
                ('facebook_lead', 'Facebook Lead', TRUE),
                ('make_webhook', 'Make.com Integration', TRUE)
            `);
            console.log('✅ Initialized default lead sources');
        }
        
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
                
                -- Reminder system columns
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='last_customer_message_time'
                ) THEN
                    ALTER TABLE leads ADD COLUMN last_customer_message_time TIMESTAMP;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='reminder_1hr_sent'
                ) THEN
                    ALTER TABLE leads ADD COLUMN reminder_1hr_sent BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='reminder_24hr_sent'
                ) THEN
                    ALTER TABLE leads ADD COLUMN reminder_24hr_sent BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='reminder_48hr_sent'
                ) THEN
                    ALTER TABLE leads ADD COLUMN reminder_48hr_sent BOOLEAN DEFAULT FALSE;
                END IF;
                
                -- Webhook timestamp column
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='leads' AND column_name='webhook_timestamp'
                ) THEN
                    ALTER TABLE leads ADD COLUMN webhook_timestamp TIMESTAMP;
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
                                   post_qualification_response_sent, answers, returning_customer, times_qualified,
                                   webhook_timestamp)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
                data.times_qualified || 0,
                data.webhook_timestamp || null
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
                    webhook_timestamp = $14, last_contact = CURRENT_TIMESTAMP
                WHERE id = $15
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
                data.webhook_timestamp !== undefined ? data.webhook_timestamp : null,
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
    
    // Delete lead (permanently)
    static async deleteLead(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            console.log(`🗑️ PostgreSQL: Starting transaction to delete lead ID: ${id}`);
            
            // Delete messages first - CHECK RESULT
            const messagesResult = await client.query('DELETE FROM messages WHERE lead_id = $1', [id]);
            console.log(`🗑️ PostgreSQL: Deleted ${messagesResult.rowCount} messages for lead ID: ${id}`);
            
            // Delete lead - CHECK RESULT
            const leadResult = await client.query('DELETE FROM leads WHERE id = $1', [id]);
            console.log(`🗑️ PostgreSQL: Deleted ${leadResult.rowCount} lead(s) with ID: ${id}`);
            
            if (leadResult.rowCount === 0) {
                console.warn(`⚠️ No lead found with ID: ${id} (may already be deleted)`);
            }
            
            await client.query('COMMIT');
            console.log(`✅ PostgreSQL: Transaction committed for lead ID: ${id}`);
            
            return {
                messagesDeleted: messagesResult.rowCount || 0,
                leadDeleted: leadResult.rowCount > 0
            };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ PostgreSQL: Transaction rolled back');
            console.error('❌ Error deleting lead from PostgreSQL:', error);
            console.error('❌ Error details:', error.message, error.code);
            throw error;
        } finally {
            client.release();
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
    
    // Generic save setting to database
    static async saveSetting(key, value) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                INSERT INTO settings (key, value, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
            `, [key, value]);
            
            console.log(`✅ Setting saved to PostgreSQL: ${key}`);
            return true;
        } catch (error) {
            console.error(`❌ Error saving setting ${key}:`, error);
            throw error;
        }
    }
    
    // Generic get setting from database
    static async getSetting(key) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT value FROM settings WHERE key = $1
            `, [key]);
            
            if (result.rows.length > 0) {
                return result.rows[0].value;
            }
            return null;
        } catch (error) {
            console.error(`❌ Error getting setting ${key}:`, error);
            return null;
        }
    }
    
    // Save reminder intervals
    static async saveReminderIntervals(first, second, final, checkInterval) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const intervals = {
                first: first,
                second: second,
                final: final,
                checkInterval: checkInterval
            };
            const intervalsJSON = JSON.stringify(intervals);
            
            await pool.query(`
                INSERT INTO settings (key, value, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
            `, ['reminderIntervals', intervalsJSON]);
            
            console.log(`✅ Reminder intervals saved to PostgreSQL`);
            return true;
        } catch (error) {
            console.error(`❌ Error saving reminder intervals:`, error);
            throw error;
        }
    }
    
    // Get reminder intervals from database
    static async getReminderIntervals() {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(`
                SELECT value FROM settings WHERE key = $1
            `, ['reminderIntervals']);
            
            if (result.rows.length > 0) {
                const intervals = JSON.parse(result.rows[0].value);
                console.log(`✅ Loaded reminder intervals from PostgreSQL`);
                return intervals;
            }
            // Return defaults if not set
            return {
                first: 5,           // 5 minutes
                second: 120,        // 120 minutes (2 hours)
                final: 900,         // 900 minutes (15 hours)
                checkInterval: 30   // 30 minutes
            };
        } catch (error) {
            console.error(`❌ Error getting reminder intervals:`, error);
            // Return defaults on error
            return {
                first: 5,
                second: 120,
                final: 900,
                checkInterval: 30
            };
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
                ORDER BY timestamp ASC
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
    
    // Update last customer message time for reminder tracking
    static async updateLastCustomerMessageTime(leadId, timestamp) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                UPDATE leads 
                SET last_customer_message_time = $1 
                WHERE id = $2
            `, [timestamp, leadId]);
            console.log(`🕐 Updated last message time for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error updating last message time:', error);
            return false;
        }
    }
    
    // Update reminder sent flag
    static async updateReminderSent(leadId, reminderType) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const columnMap = {
                '1hr': 'reminder_1hr_sent',
                '24hr': 'reminder_24hr_sent',
                '48hr': 'reminder_48hr_sent'
            };
            
            const column = columnMap[reminderType];
            if (!column) {
                console.error(`❌ Invalid reminder type: ${reminderType}`);
                return false;
            }
            
            await pool.query(`
                UPDATE leads 
                SET ${column} = TRUE 
                WHERE id = $1
            `, [leadId]);
            console.log(`✅ Marked ${reminderType} reminder as sent for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error updating reminder flag:', error);
            return false;
        }
    }
    
    // Reset reminder flags (when customer responds)
    static async resetReminderFlags(leadId) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(`
                UPDATE leads 
                SET reminder_1hr_sent = FALSE,
                    reminder_24hr_sent = FALSE,
                    reminder_48hr_sent = FALSE
                WHERE id = $1
            `, [leadId]);
            console.log(`🔄 Reset reminder flags for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error resetting reminder flags:', error);
            return false;
        }
    }
    
    // ============================================================================
    // LEAD SOURCE MANAGEMENT FUNCTIONS
    // ============================================================================
    
    // Get all lead sources
    static async getLeadSources() {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query('SELECT * FROM lead_sources ORDER BY display_name ASC');
            return result.rows;
        } catch (error) {
            console.error('❌ Error getting lead sources:', error);
            return [];
        }
    }
    
    // Get source by technical ID
    static async getSourceByTechnicalId(technicalId) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(
                'SELECT * FROM lead_sources WHERE technical_id = $1 AND active = TRUE',
                [technicalId]
            );
            return result.rows[0] || null;
        } catch (error) {
            console.error('❌ Error getting source by technical ID:', error);
            return null;
        }
    }
    
    // Create new lead source
    static async createLeadSource(technicalId, displayName) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            const result = await pool.query(
                `INSERT INTO lead_sources (technical_id, display_name, active)
                 VALUES ($1, $2, TRUE)
                 RETURNING *`,
                [technicalId, displayName]
            );
            console.log(`✅ Created lead source: ${technicalId} → ${displayName}`);
            return result.rows[0];
        } catch (error) {
            console.error('❌ Error creating lead source:', error);
            throw error;
        }
    }
    
    // Update lead source
    static async updateLeadSource(id, displayName, active) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            await pool.query(
                `UPDATE lead_sources 
                 SET display_name = $1, active = $2
                 WHERE id = $3`,
                [displayName, active, id]
            );
            console.log(`✅ Updated lead source ID: ${id}`);
            return true;
        } catch (error) {
            console.error('❌ Error updating lead source:', error);
            return false;
        }
    }
    
    // Delete lead source
    static async deleteLeadSource(id) {
        if (!isPostgreSQL) {
            throw new Error('PostgreSQL not available');
        }
        
        try {
            // Check if any leads use this source
            const checkResult = await pool.query(
                `SELECT COUNT(*) as count FROM leads 
                 WHERE source = (SELECT technical_id FROM lead_sources WHERE id = $1)`,
                [id]
            );
            
            if (parseInt(checkResult.rows[0].count) > 0) {
                throw new Error(`Cannot delete source: ${checkResult.rows[0].count} leads are using this source`);
            }
            
            await pool.query('DELETE FROM lead_sources WHERE id = $1', [id]);
            console.log(`🗑️ Deleted lead source ID: ${id}`);
            return true;
        } catch (error) {
            console.error('❌ Error deleting lead source:', error);
            throw error;
        }
    }
}

module.exports = {
    pool,
    LeadDatabase,
    initializeDatabase,
    isPostgreSQL,
    queryWithRetry
};
