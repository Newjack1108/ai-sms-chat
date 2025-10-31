// SQLite Database for Lead Qualification System
const Database = require('better-sqlite3');
const path = require('path');

// Initialize database with Railway persistent storage
let dbPath;
if (process.env.DATABASE_URL) {
    // PostgreSQL is available, don't use SQLite
    console.log('🗄️ PostgreSQL detected, skipping SQLite initialization');
    dbPath = null;
} else if (process.env.DATABASE_PATH) {
    // Use custom database path
    dbPath = process.env.DATABASE_PATH;
} else if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    // Use Railway persistent volume (create directory if needed)
    const fs = require('fs');
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!fs.existsSync(volumePath)) {
        console.log(`📁 Creating directory: ${volumePath}`);
        fs.mkdirSync(volumePath, { recursive: true });
    }
    dbPath = path.join(volumePath, 'leads.db');
} else if (process.env.RAILWAY_ENVIRONMENT) {
    // Railway environment - use /app directory (persistent)
    dbPath = '/app/leads.db';
} else {
    // Local development fallback
    dbPath = path.join(__dirname, 'leads.db');
}

let db;
if (dbPath === null) {
    // PostgreSQL is available, SQLite not needed
    console.log('🗄️ PostgreSQL available, SQLite database not initialized');
    db = null;
} else {
    try {
        db = new Database(dbPath);
        console.log(`🗄️ Database location: ${dbPath}`);
        console.log(`✅ Database connection successful`);
        console.log(`🌍 Environment: ${process.env.RAILWAY_ENVIRONMENT || 'local'}`);
        console.log(`📁 Railway Volume: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'Not set'}`);
    } catch (error) {
        console.error(`❌ Database connection failed: ${error.message}`);
        console.error(`📁 Attempted path: ${dbPath}`);
        console.error(`🌍 Environment: ${process.env.RAILWAY_ENVIRONMENT || 'local'}`);
        console.error(`📁 Railway Volume: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'Not set'}`);
        
        // Try fallback to /app if other paths fail
        if (dbPath !== '/app/leads.db') {
            console.log(`🔄 Trying fallback to /app/leads.db...`);
            try {
                dbPath = '/app/leads.db';
                db = new Database(dbPath);
                console.log(`✅ Fallback database connection successful: ${dbPath}`);
            } catch (fallbackError) {
                console.error(`❌ Fallback database connection also failed: ${fallbackError.message}`);
                throw fallbackError;
            }
        } else {
            throw error;
        }
    }
}

// Enable foreign keys (only if SQLite is being used)
if (db) {
    db.pragma('foreign_keys = ON');
}

// Initialize database schema
function initializeDatabase() {
    if (!db) {
        console.log('⚠️ SQLite database not available (PostgreSQL in use)');
        return;
    }
    
    console.log('🗄️ Initializing SQLite database...');
    
    // Create leads table
    db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT,
            email TEXT,
            source TEXT DEFAULT 'inbound_sms',
            status TEXT DEFAULT 'new',
            progress INTEGER DEFAULT 0,
            qualified INTEGER DEFAULT 0,
            archived INTEGER DEFAULT 0,
            ai_paused INTEGER DEFAULT 0,
            post_qualification_response_sent INTEGER DEFAULT 0,
            answers TEXT,
            qualifiedDate TEXT,
            returning_customer INTEGER DEFAULT 0,
            times_qualified INTEGER DEFAULT 0,
            first_qualified_date TEXT,
            last_qualified_date TEXT,
            last_customer_message_time TEXT,
            reminder_1hr_sent INTEGER DEFAULT 0,
            reminder_24hr_sent INTEGER DEFAULT 0,
            reminder_48hr_sent INTEGER DEFAULT 0,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            lastContact TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Create messages table
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            leadId INTEGER NOT NULL,
            sender TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (leadId) REFERENCES leads(id) ON DELETE CASCADE
        )
    `);
    
    // Create settings table for custom questions
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Create lead_sources table for managing lead source mappings
    db.exec(`
        CREATE TABLE IF NOT EXISTS lead_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            technical_id TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Insert default lead sources if table is empty
    const sourceCount = db.prepare('SELECT COUNT(*) as count FROM lead_sources').get();
    if (sourceCount.count === 0) {
        const insertSource = db.prepare(`
            INSERT INTO lead_sources (technical_id, display_name, active)
            VALUES (?, ?, 1)
        `);
        
        insertSource.run('inbound_sms', 'SMS Inbound');
        insertSource.run('manual', 'Manual Entry');
        insertSource.run('gravity_form_cs', 'CS Website Lead');
        insertSource.run('gravity_form_csgb', 'CSGB Website Lead');
        insertSource.run('facebook_lead', 'Facebook Lead');
        insertSource.run('make_webhook', 'Make.com Integration');
        
        console.log('✅ Initialized default lead sources');
    }
    
    // Create index for faster queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
        CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived);
        CREATE INDEX IF NOT EXISTS idx_messages_leadId ON messages(leadId);
    `);
    
    // Add new columns if they don't exist (migration for existing databases)
    try {
        const columns = db.prepare("PRAGMA table_info(leads)").all();
        
        if (!columns.some(col => col.name === 'post_qualification_response_sent')) {
            db.exec('ALTER TABLE leads ADD COLUMN post_qualification_response_sent INTEGER DEFAULT 0');
            console.log('✅ Added post_qualification_response_sent column');
        }
        
        if (!columns.some(col => col.name === 'returning_customer')) {
            db.exec('ALTER TABLE leads ADD COLUMN returning_customer INTEGER DEFAULT 0');
            console.log('✅ Added returning_customer column');
        }
        
        if (!columns.some(col => col.name === 'times_qualified')) {
            db.exec('ALTER TABLE leads ADD COLUMN times_qualified INTEGER DEFAULT 0');
            console.log('✅ Added times_qualified column');
        }
        
        if (!columns.some(col => col.name === 'first_qualified_date')) {
            db.exec('ALTER TABLE leads ADD COLUMN first_qualified_date TEXT');
            console.log('✅ Added first_qualified_date column');
        }
        
        if (!columns.some(col => col.name === 'last_qualified_date')) {
            db.exec('ALTER TABLE leads ADD COLUMN last_qualified_date TEXT');
            console.log('✅ Added last_qualified_date column');
        }
        
        // Reminder system columns
        if (!columns.some(col => col.name === 'last_customer_message_time')) {
            db.exec('ALTER TABLE leads ADD COLUMN last_customer_message_time TEXT');
            console.log('✅ Added last_customer_message_time column');
        }
        
        if (!columns.some(col => col.name === 'reminder_1hr_sent')) {
            db.exec('ALTER TABLE leads ADD COLUMN reminder_1hr_sent INTEGER DEFAULT 0');
            console.log('✅ Added reminder_1hr_sent column');
        }
        
        if (!columns.some(col => col.name === 'reminder_24hr_sent')) {
            db.exec('ALTER TABLE leads ADD COLUMN reminder_24hr_sent INTEGER DEFAULT 0');
            console.log('✅ Added reminder_24hr_sent column');
        }
        
        if (!columns.some(col => col.name === 'reminder_48hr_sent')) {
            db.exec('ALTER TABLE leads ADD COLUMN reminder_48hr_sent INTEGER DEFAULT 0');
            console.log('✅ Added reminder_48hr_sent column');
        }
    } catch (error) {
        console.log('⚠️ Migration check skipped:', error.message);
    }
    
    console.log('✅ Database initialized successfully');
}

// Database will be initialized when needed

// Prepared statements for better performance (created AFTER tables exist)
const statements = db ? {
    // Lead operations
    createLead: db.prepare(`
        INSERT INTO leads (phone, name, email, source, status, progress, qualified, ai_paused, 
                           post_qualification_response_sent, answers, returning_customer, times_qualified,
                           last_customer_message_time, reminder_1hr_sent, reminder_24hr_sent, reminder_48hr_sent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    
    getLeadByPhone: db.prepare(`
        SELECT * FROM leads WHERE phone = ? AND archived = 0
    `),
    
    getLeadById: db.prepare(`
        SELECT * FROM leads WHERE id = ? AND archived = 0
    `),
    
    getAllLeads: db.prepare(`
        SELECT * FROM leads WHERE archived = 0 ORDER BY lastContact DESC
    `),
    
    updateLead: db.prepare(`
        UPDATE leads 
        SET name = ?, email = ?, status = ?, progress = ?, qualified = ?, 
            ai_paused = ?, post_qualification_response_sent = ?, answers = ?, qualifiedDate = ?,
            returning_customer = ?, times_qualified = ?, first_qualified_date = ?, last_qualified_date = ?,
            last_customer_message_time = ?, reminder_1hr_sent = ?, reminder_24hr_sent = ?, reminder_48hr_sent = ?,
            lastContact = CURRENT_TIMESTAMP
        WHERE id = ?
    `),
    
    archiveLead: db.prepare(`
        UPDATE leads SET archived = 1 WHERE id = ?
    `),
    
    deleteLead: db.prepare(`
        DELETE FROM leads WHERE id = ?
    `),
    
    updateLastContact: db.prepare(`
        UPDATE leads SET lastContact = CURRENT_TIMESTAMP WHERE id = ?
    `),
    
    // Message operations
    createMessage: db.prepare(`
        INSERT INTO messages (leadId, sender, content, timestamp)
        VALUES (?, ?, ?, ?)
    `),
    
    getMessagesByLeadId: db.prepare(`
        SELECT * FROM messages WHERE leadId = ? ORDER BY timestamp ASC
    `),
    
    deleteMessagesByLeadId: db.prepare(`
        DELETE FROM messages WHERE leadId = ?
    `),
    
    // Settings operations
    saveSetting: db.prepare(`
        INSERT OR REPLACE INTO settings (key, value, updatedAt)
        VALUES (?, ?, CURRENT_TIMESTAMP)
    `),
    
    getSetting: db.prepare(`
        SELECT value FROM settings WHERE key = ?
    `)
} : {};

// Database functions
class LeadDatabase {
    // Check if SQLite is available
    static isAvailable() {
        return db !== null;
    }

    // Create a new lead
    static createLead(data) {
        if (!this.isAvailable()) {
            throw new Error('SQLite database not available - using PostgreSQL instead');
        }
        try {
            const answers = data.answers ? JSON.stringify(data.answers) : '{}';
            
            const result = statements.createLead.run(
                data.phone,
                data.name || 'Unknown',
                data.email || '',
                data.source || 'inbound_sms',
                data.status || 'new',
                data.progress || 0,
                data.qualified || 0,
                data.ai_paused || 0,
                data.post_qualification_response_sent || 0,
                answers,
                data.returning_customer || 0,
                data.times_qualified || 0,
                data.last_customer_message_time || null,
                data.reminder_1hr_sent || 0,
                data.reminder_24hr_sent || 0,
                data.reminder_48hr_sent || 0
            );
            
            console.log(`✅ Created lead with ID: ${result.lastInsertRowid}`);
            return this.getLeadById(result.lastInsertRowid);
        } catch (error) {
            console.error('❌ Error creating lead:', error);
            throw error;
        }
    }
    
    // Get lead by phone number
    static getLeadByPhone(phone) {
        try {
            const lead = statements.getLeadByPhone.get(phone);
            if (lead) {
                lead.answers = lead.answers ? JSON.parse(lead.answers) : {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                lead.post_qualification_response_sent = Boolean(lead.post_qualification_response_sent);
                lead.returning_customer = Boolean(lead.returning_customer);
            }
            return lead;
        } catch (error) {
            console.error('❌ Error getting lead by phone:', error);
            throw error;
        }
    }
    
    // Get lead by ID
    static getLeadById(id) {
        try {
            const lead = statements.getLeadById.get(id);
            if (lead) {
                lead.answers = lead.answers ? JSON.parse(lead.answers) : {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                lead.post_qualification_response_sent = Boolean(lead.post_qualification_response_sent);
                lead.returning_customer = Boolean(lead.returning_customer);
            }
            return lead;
        } catch (error) {
            console.error('❌ Error getting lead by ID:', error);
            throw error;
        }
    }
    
    // Get all leads (not archived)
    static getAllLeads() {
        try {
            const leads = statements.getAllLeads.all();
            return leads.map(lead => {
                lead.answers = lead.answers ? JSON.parse(lead.answers) : {};
                lead.qualified = Boolean(lead.qualified);
                lead.archived = Boolean(lead.archived);
                lead.ai_paused = Boolean(lead.ai_paused);
                lead.post_qualification_response_sent = Boolean(lead.post_qualification_response_sent);
                lead.returning_customer = Boolean(lead.returning_customer);
                return lead;
            });
        } catch (error) {
            console.error('❌ Error getting all leads:', error);
            throw error;
        }
    }
    
    // Update lead
    static updateLead(id, data) {
        try {
            const answers = data.answers ? JSON.stringify(data.answers) : '{}';
            
            statements.updateLead.run(
                data.name,
                data.email,
                data.status,
                data.progress,
                data.qualified ? 1 : 0,
                data.ai_paused ? 1 : 0,
                data.post_qualification_response_sent ? 1 : 0,
                answers,
                data.qualifiedDate || null,
                data.returning_customer ? 1 : 0,
                data.times_qualified || 0,
                data.first_qualified_date || null,
                data.last_qualified_date || null,
                data.last_customer_message_time || null,
                data.reminder_1hr_sent ? 1 : 0,
                data.reminder_24hr_sent ? 1 : 0,
                data.reminder_48hr_sent ? 1 : 0,
                id
            );
            
            console.log(`✅ Updated lead ID: ${id}`);
            return this.getLeadById(id);
        } catch (error) {
            console.error('❌ Error updating lead:', error);
            throw error;
        }
    }
    
    // Archive lead (soft delete)
    static archiveLead(id) {
        try {
            statements.archiveLead.run(id);
            console.log(`📦 Archived lead ID: ${id}`);
            return true;
        } catch (error) {
            console.error('❌ Error archiving lead:', error);
            throw error;
        }
    }
    
    // Delete lead permanently
    static deleteLead(id) {
        try {
            // Delete messages first (cascade should handle this, but being explicit)
            const messagesResult = statements.deleteMessagesByLeadId.run(id);
            console.log(`🗑️ SQLite: Deleted ${messagesResult.changes} messages for lead ID: ${id}`);
            
            // Delete lead
            const leadResult = statements.deleteLead.run(id);
            console.log(`🗑️ SQLite: Deleted ${leadResult.changes} lead(s) with ID: ${id}`);
            
            if (leadResult.changes === 0) {
                console.warn(`⚠️ No lead found with ID: ${id} (may already be deleted)`);
            }
            
            return {
                messagesDeleted: messagesResult.changes || 0,
                leadDeleted: leadResult.changes > 0
            };
        } catch (error) {
            console.error('❌ Error deleting lead from SQLite:', error);
            throw error;
        }
    }
    
    // Update last contact timestamp
    static updateLastContact(id) {
        try {
            statements.updateLastContact.run(id);
        } catch (error) {
            console.error('❌ Error updating last contact:', error);
            throw error;
        }
    }
    
    // Create message
    static createMessage(leadId, sender, content, timestamp = null) {
        try {
            const ts = timestamp || new Date().toISOString();
            
            const result = statements.createMessage.run(
                leadId,
                sender,
                content,
                ts
            );
            
            // Update last contact for the lead
            this.updateLastContact(leadId);
            
            return {
                id: result.lastInsertRowid,
                leadId,
                sender,
                content,
                timestamp: ts
            };
        } catch (error) {
            console.error('❌ Error creating message:', error);
            throw error;
        }
    }
    
    // Get all messages for a lead
    static getMessagesByLeadId(leadId) {
        try {
            return statements.getMessagesByLeadId.all(leadId);
        } catch (error) {
            console.error('❌ Error getting messages:', error);
            throw error;
        }
    }
    
    // Check if customer exists (returns lead if exists, null if new)
    // Also restores archived customers when they message
    static checkExistingCustomer(phone) {
        try {
            // First try to get active (non-archived) lead
            const activeLead = this.getLeadByPhone(phone);
            if (activeLead) {
                console.log(`👤 Found existing customer: ${activeLead.name} (${activeLead.phone})`);
                console.log(`   Status: ${activeLead.status}, Progress: ${activeLead.progress}%`);
                return activeLead;
            }
            
            // Check if customer exists but is archived
            const archivedCheck = db.prepare(`
                SELECT * FROM leads WHERE phone = ? AND archived = 1
            `).get(phone);
            
            if (archivedCheck) {
                // Customer was archived - restore them
                console.log(`📥 Restoring archived customer: ${archivedCheck.name} (${phone})`);
                
                db.prepare(`
                    UPDATE leads 
                    SET archived = 0, lastContact = CURRENT_TIMESTAMP 
                    WHERE phone = ?
                `).run(phone);
                
                // Return restored lead
                const restoredLead = this.getLeadByPhone(phone);
                console.log(`✅ Customer restored from archive: ${restoredLead.name}`);
                return restoredLead;
            }
            
            console.log(`🆕 New customer detected: ${phone}`);
            return null;
        } catch (error) {
            console.error('❌ Error checking existing customer:', error);
            throw error;
        }
    }
    
    // Get conversation history for a lead
    static getConversationHistory(leadId) {
        try {
            const messages = this.getMessagesByLeadId(leadId);
            console.log(`📜 Loaded ${messages.length} messages for lead ID: ${leadId}`);
            return messages;
        } catch (error) {
            console.error('❌ Error getting conversation history:', error);
            throw error;
        }
    }
    
    // Save custom questions to database
    static saveCustomQuestions(questions) {
        try {
            const questionsJSON = JSON.stringify(questions);
            statements.saveSetting.run('customQuestions', questionsJSON);
            console.log('✅ Custom questions saved to database');
            return true;
        } catch (error) {
            console.error('❌ Error saving custom questions:', error);
            throw error;
        }
    }
    
    // Get custom questions from database
    static getCustomQuestions() {
        try {
            const result = statements.getSetting.get('customQuestions');
            if (result && result.value) {
                const questions = JSON.parse(result.value);
                console.log('✅ Loaded custom questions from database');
                return questions;
            }
            console.log('⚠️ No custom questions in database, using defaults');
            return null;
        } catch (error) {
            console.error('❌ Error getting custom questions:', error);
            return null;
        }
    }
    
    // Save assistant name to database
    static saveAssistantName(name) {
        try {
            statements.saveSetting.run('assistantName', name);
            console.log(`✅ Assistant name saved to database: ${name}`);
            return true;
        } catch (error) {
            console.error('❌ Error saving assistant name:', error);
            throw error;
        }
    }
    
    // Get assistant name from database
    static getAssistantName() {
        try {
            const result = statements.getSetting.get('assistantName');
            if (result && result.value) {
                console.log(`✅ Loaded assistant name from database: ${result.value}`);
                return result.value;
            }
            return null;
        } catch (error) {
            console.error('❌ Error getting assistant name:', error);
            return null;
        }
    }
    
    // Generic save setting to database
    static saveSetting(key, value) {
        try {
            statements.saveSetting.run(key, value);
            console.log(`✅ Setting saved to database: ${key}`);
            return true;
        } catch (error) {
            console.error(`❌ Error saving setting ${key}:`, error);
            throw error;
        }
    }
    
    // Generic get setting from database
    static getSetting(key) {
        try {
            const result = statements.getSetting.get(key);
            if (result && result.value) {
                return result.value;
            }
            return null;
        } catch (error) {
            console.error(`❌ Error getting setting ${key}:`, error);
            return null;
        }
    }
    
    // Save reminder intervals
    static saveReminderIntervals(first, second, final, checkInterval) {
        try {
            const intervals = {
                first: first,
                second: second,
                final: final,
                checkInterval: checkInterval
            };
            const intervalsJSON = JSON.stringify(intervals);
            statements.saveSetting.run('reminderIntervals', intervalsJSON);
            console.log(`✅ Reminder intervals saved to database`);
            return true;
        } catch (error) {
            console.error(`❌ Error saving reminder intervals:`, error);
            throw error;
        }
    }
    
    // Get reminder intervals from database
    static getReminderIntervals() {
        try {
            const result = statements.getSetting.get('reminderIntervals');
            if (result && result.value) {
                const intervals = JSON.parse(result.value);
                console.log(`✅ Loaded reminder intervals from database`);
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

    // Pause AI for a lead
    static pauseAI(leadId) {
        try {
            const lead = this.getLeadById(leadId);
            if (!lead) {
                console.error(`❌ Lead not found: ${leadId}`);
                return false;
            }
            
            statements.updateLead.run(
                lead.name,
                lead.email,
                lead.status,
                lead.progress,
                lead.qualified ? 1 : 0,
                1,    // ai_paused = true
                lead.post_qualification_response_sent ? 1 : 0,
                lead.answers ? JSON.stringify(lead.answers) : '{}',
                lead.qualifiedDate,
                lead.returning_customer ? 1 : 0,
                lead.times_qualified || 0,
                lead.first_qualified_date || null,
                lead.last_qualified_date || null,
                lead.last_customer_message_time || null,
                lead.reminder_1hr_sent ? 1 : 0,
                lead.reminder_24hr_sent ? 1 : 0,
                lead.reminder_48hr_sent ? 1 : 0,
                leadId
            );
            console.log(`⏸️ AI paused for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error pausing AI:', error);
            return false;
        }
    }

    // Unpause AI for a lead
    static unpauseAI(leadId) {
        try {
            const lead = this.getLeadById(leadId);
            if (!lead) {
                console.error(`❌ Lead not found: ${leadId}`);
                return false;
            }
            
            statements.updateLead.run(
                lead.name,
                lead.email,
                lead.status,
                lead.progress,
                lead.qualified ? 1 : 0,
                0,    // ai_paused = false
                lead.post_qualification_response_sent ? 1 : 0,
                lead.answers ? JSON.stringify(lead.answers) : '{}',
                lead.qualifiedDate,
                lead.returning_customer ? 1 : 0,
                lead.times_qualified || 0,
                lead.first_qualified_date || null,
                lead.last_qualified_date || null,
                lead.last_customer_message_time || null,
                lead.reminder_1hr_sent ? 1 : 0,
                lead.reminder_24hr_sent ? 1 : 0,
                lead.reminder_48hr_sent ? 1 : 0,
                leadId
            );
            console.log(`▶️ AI unpaused for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error unpausing AI:', error);
            return false;
        }
    }
    
    // Update last customer message time for reminder tracking
    static updateLastCustomerMessageTime(leadId, timestamp) {
        try {
            if (!db) return false;
            
            const stmt = db.prepare(`
                UPDATE leads 
                SET last_customer_message_time = ? 
                WHERE id = ?
            `);
            stmt.run(timestamp, leadId);
            console.log(`🕐 Updated last message time for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error updating last message time:', error);
            return false;
        }
    }
    
    // Update reminder sent flag
    static updateReminderSent(leadId, reminderType) {
        try {
            if (!db) return false;
            
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
            
            const stmt = db.prepare(`
                UPDATE leads 
                SET ${column} = 1 
                WHERE id = ?
            `);
            stmt.run(leadId);
            console.log(`✅ Marked ${reminderType} reminder as sent for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error updating reminder flag:', error);
            return false;
        }
    }
    
    // Reset reminder flags (when customer responds)
    static resetReminderFlags(leadId) {
        try {
            if (!db) return false;
            
            const stmt = db.prepare(`
                UPDATE leads 
                SET reminder_1hr_sent = 0,
                    reminder_24hr_sent = 0,
                    reminder_48hr_sent = 0
                WHERE id = ?
            `);
            stmt.run(leadId);
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
    static getLeadSources() {
        try {
            if (!db) return [];
            const stmt = db.prepare('SELECT * FROM lead_sources ORDER BY display_name ASC');
            return stmt.all();
        } catch (error) {
            console.error('❌ Error getting lead sources:', error);
            return [];
        }
    }
    
    // Get source by technical ID
    static getSourceByTechnicalId(technicalId) {
        try {
            if (!db) return null;
            const stmt = db.prepare('SELECT * FROM lead_sources WHERE technical_id = ? AND active = 1');
            return stmt.get(technicalId);
        } catch (error) {
            console.error('❌ Error getting source by technical ID:', error);
            return null;
        }
    }
    
    // Create new lead source
    static createLeadSource(technicalId, displayName) {
        try {
            if (!db) return null;
            const stmt = db.prepare(`
                INSERT INTO lead_sources (technical_id, display_name, active)
                VALUES (?, ?, 1)
            `);
            const result = stmt.run(technicalId, displayName);
            console.log(`✅ Created lead source: ${technicalId} → ${displayName}`);
            return { id: result.lastInsertRowid, technical_id: technicalId, display_name: displayName, active: 1 };
        } catch (error) {
            console.error('❌ Error creating lead source:', error);
            throw error;
        }
    }
    
    // Update lead source
    static updateLeadSource(id, displayName, active) {
        try {
            if (!db) return false;
            const stmt = db.prepare(`
                UPDATE lead_sources 
                SET display_name = ?, active = ?
                WHERE id = ?
            `);
            stmt.run(displayName, active ? 1 : 0, id);
            console.log(`✅ Updated lead source ID: ${id}`);
            return true;
        } catch (error) {
            console.error('❌ Error updating lead source:', error);
            return false;
        }
    }
    
    // Delete lead source
    static deleteLeadSource(id) {
        try {
            if (!db) return false;
            // Check if any leads use this source
            const checkStmt = db.prepare('SELECT COUNT(*) as count FROM leads WHERE source = (SELECT technical_id FROM lead_sources WHERE id = ?)');
            const result = checkStmt.get(id);
            
            if (result.count > 0) {
                throw new Error(`Cannot delete source: ${result.count} leads are using this source`);
            }
            
            const stmt = db.prepare('DELETE FROM lead_sources WHERE id = ?');
            stmt.run(id);
            console.log(`🗑️ Deleted lead source ID: ${id}`);
            return true;
        } catch (error) {
            console.error('❌ Error deleting lead source:', error);
            throw error;
        }
    }
    
}

module.exports = {
    db,
    LeadDatabase,
    initializeDatabase
};
