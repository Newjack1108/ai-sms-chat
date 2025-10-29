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
    
    // Create index for faster queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
        CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived);
        CREATE INDEX IF NOT EXISTS idx_messages_leadId ON messages(leadId);
    `);
    
    // Add new column if it doesn't exist (migration for existing databases)
    try {
        const columns = db.prepare("PRAGMA table_info(leads)").all();
        const hasColumn = columns.some(col => col.name === 'post_qualification_response_sent');
        if (!hasColumn) {
            db.exec('ALTER TABLE leads ADD COLUMN post_qualification_response_sent INTEGER DEFAULT 0');
            console.log('✅ Added post_qualification_response_sent column to existing database');
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
        INSERT INTO leads (phone, name, email, source, status, progress, qualified, ai_paused, answers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ai_paused = ?, post_qualification_response_sent = ?, answers = ?, qualifiedDate = ?, lastContact = CURRENT_TIMESTAMP
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
                answers
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
            statements.deleteMessagesByLeadId.run(id);
            
            // Delete lead
            statements.deleteLead.run(id);
            
            console.log(`🗑️ Permanently deleted lead ID: ${id}`);
            return true;
        } catch (error) {
            console.error('❌ Error deleting lead:', error);
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
    static checkExistingCustomer(phone) {
        try {
            const lead = this.getLeadByPhone(phone);
            if (lead) {
                console.log(`👤 Found existing customer: ${lead.name} (${lead.phone})`);
                console.log(`   Status: ${lead.status}, Progress: ${lead.progress}%`);
                return lead;
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
                leadId
            );
            console.log(`▶️ AI unpaused for lead ID: ${leadId}`);
            return true;
        } catch (error) {
            console.error('❌ Error unpausing AI:', error);
            return false;
        }
    }
    
}

module.exports = {
    db,
    LeadDatabase,
    initializeDatabase
};
