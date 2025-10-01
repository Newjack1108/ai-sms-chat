# Database Persistence Guide - v5.6.0

## Overview

The AI Lead Qualification System now uses **SQLite** for persistent storage. All customer data, conversation history, and lead information is stored in a database file that persists across server restarts and deployments.

## Database Technology

**SQLite with better-sqlite3**
- Lightweight, file-based database
- No external database server required
- Perfect for Railway deployment
- Fast synchronous API
- Automatic transactions

## Database Schema

### `leads` Table
```sql
CREATE TABLE leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,           -- Normalized phone number
    name TEXT,                             -- Customer name
    email TEXT,                            -- Customer email
    source TEXT DEFAULT 'inbound_sms',    -- Lead source
    status TEXT DEFAULT 'new',             -- new, active, qualified
    progress INTEGER DEFAULT 0,            -- 0-100%
    qualified INTEGER DEFAULT 0,           -- 0 or 1 (boolean)
    archived INTEGER DEFAULT 0,            -- 0 or 1 (soft delete)
    answers TEXT,                          -- JSON string of Q&A
    qualifiedDate TEXT,                    -- ISO timestamp
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    lastContact TEXT DEFAULT CURRENT_TIMESTAMP
)
```

### `messages` Table
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leadId INTEGER NOT NULL,              -- Foreign key to leads
    sender TEXT NOT NULL,                  -- 'customer' or 'assistant'
    content TEXT NOT NULL,                 -- Message text
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (leadId) REFERENCES leads(id) ON DELETE CASCADE
)
```

### Indexes
```sql
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_leads_archived ON leads(archived);
CREATE INDEX idx_messages_leadId ON messages(leadId);
```

## Key Features

### 1. Existing Customer Detection

When an SMS arrives, the system:
```javascript
let lead = LeadDatabase.checkExistingCustomer(normalizedPhone);

if (lead) {
    // Returning customer
    console.log(`🔄 Welcome back ${lead.name}!`);
    const history = LeadDatabase.getConversationHistory(lead.id);
    // Continue conversation seamlessly
} else {
    // New customer
    lead = LeadDatabase.createLead({ phone, name, ... });
}
```

### 2. Conversation History

All messages are stored and can be retrieved:
```javascript
const messages = LeadDatabase.getMessagesByLeadId(leadId);
// Returns array of all messages for this lead
```

### 3. Persistent Answers

Lead answers are stored as JSON in the database:
```javascript
{
    "question_1": "Double stable",
    "question_2": "Yes, mobile",
    "question_3": "Asap",
    "question_4": "SW1A 1AA"
}
```

### 4. Archive Functionality

Soft delete (hide from views, keep in database):
```javascript
LeadDatabase.archiveLead(leadId);
// Sets archived = 1, hidden from getAllLeads()
```

Hard delete (permanent removal):
```javascript
LeadDatabase.deleteLead(leadId);
// Deletes lead and all messages (cascade)
```

## Database Operations

### Create Lead
```javascript
const lead = LeadDatabase.createLead({
    phone: '+447809505864',
    name: 'John Smith',
    email: 'john@example.com',
    source: 'inbound_sms',
    status: 'new',
    progress: 0,
    qualified: false,
    answers: {}
});
```

### Get Lead
```javascript
// By phone
const lead = LeadDatabase.getLeadByPhone('+447809505864');

// By ID
const lead = LeadDatabase.getLeadById(1);

// All leads (not archived)
const allLeads = LeadDatabase.getAllLeads();
```

### Update Lead
```javascript
LeadDatabase.updateLead(leadId, {
    name: 'John Smith',
    email: 'john@example.com',
    status: 'qualified',
    progress: 100,
    qualified: true,
    answers: { question_1: 'Double', ... },
    qualifiedDate: new Date().toISOString()
});
```

### Create Message
```javascript
LeadDatabase.createMessage(
    leadId,           // Lead ID
    'customer',       // 'customer' or 'assistant'
    'Hello, I need help'  // Message content
);
```

### Get Messages
```javascript
const messages = LeadDatabase.getMessagesByLeadId(leadId);
// Returns: [{ id, leadId, sender, content, timestamp }, ...]
```

## Database Location

### Development (Local)
- Location: `./leads.db` (project root)
- Committed to: `.gitignore` (not tracked)
- Can be deleted to reset

### Production (Railway)
- Location: `/app/leads.db` (mounted volume)
- Persists across deployments
- Backed up automatically by Railway

## Returning Customer Flow

```
1. Customer texts: "+447809505864: Hi again"
   ↓
2. Webhook receives SMS
   ↓
3. Normalize phone: "+447809505864"
   ↓
4. Check database: LeadDatabase.checkExistingCustomer()
   ↓
5. Found existing lead:
   - ID: 1
   - Name: "John Smith"
   - Status: "qualified"
   - Progress: 100%
   ↓
6. Load conversation history (15 messages)
   ↓
7. Detect qualified status → Free chat mode
   ↓
8. AI responds naturally (not asking questions)
   ↓
9. Store new message in database
   ↓
10. Update lastContact timestamp
```

## Migration from In-Memory

**Before (v5.5.0):**
```javascript
let leads = [];  // Lost on restart
let messages = [];  // Lost on restart
```

**After (v5.6.0):**
```javascript
const leads = LeadDatabase.getAllLeads();  // Persistent
const messages = LeadDatabase.getMessagesByLeadId(id);  // Persistent
```

## Performance

- **SQLite** is extremely fast for this use case
- Indexes on phone and leadId ensure quick lookups
- Synchronous API (no await needed for DB operations)
- Handles thousands of leads easily
- Average query time: < 1ms

## Backup & Recovery

### Manual Backup
```bash
# Copy database file
cp leads.db leads.backup.$(date +%Y%m%d).db
```

### Restore from Backup
```bash
# Replace current database
cp leads.backup.20251001.db leads.db
# Restart server
```

### Railway Backup
Railway automatically backs up volume data. To restore:
1. Go to Railway dashboard
2. Select your service
3. Volume → Backups
4. Restore from snapshot

## Troubleshooting

### Database Locked
**Problem:** `Error: database is locked`
**Solution:** SQLite uses file locking. Only one writer at a time.
- better-sqlite3 handles this automatically
- If persistent, check for crashed processes

### Database Not Found
**Problem:** `Error: SQLITE_CANTOPEN`
**Solution:** Database file doesn't exist
- Will be created automatically on first run
- Check file permissions
- Check DATABASE_PATH environment variable

### Data Not Persisting
**Problem:** Data disappears after restart
**Solution:** Check Railway volume is mounted
- Railway dashboard → Service → Volume
- Should be mounted to `/app`
- Database path should be `/app/leads.db`

### Corrupted Database
**Problem:** `Error: database disk image is malformed`
**Solution:** Database file corrupted
- Restore from backup
- Or delete and recreate (loses data)

## Environment Variables

```bash
# Optional: Custom database location
DATABASE_PATH=/custom/path/leads.db

# Railway automatically provides:
RAILWAY_VOLUME_MOUNT_PATH=/app
```

## Best Practices

1. **Regular Backups**: Backup database file daily
2. **Monitor Size**: SQLite handles large databases well, but monitor growth
3. **Archive Old Leads**: Use `archiveLead()` instead of delete to keep history
4. **Test Locally First**: Test database operations locally before deploying
5. **Check Logs**: Monitor server logs for database errors

## Database Tools

### SQLite Browser
View/edit database file:
- Download: https://sqlitebrowser.org/
- Open: `leads.db`
- Browse tables, run queries

### Command Line
```bash
# Open database
sqlite3 leads.db

# List tables
.tables

# View schema
.schema leads

# Query data
SELECT * FROM leads;

# Exit
.quit
```

## FAQ

**Q: Will I lose data when deploying to Railway?**
A: No, if Railway volume is properly configured, data persists.

**Q: Can I export customer data?**
A: Yes, use SQLite Browser or command-line tools to export to CSV/JSON.

**Q: How do I reset the database?**
A: Delete `leads.db` file and restart server. New empty database will be created.

**Q: Can multiple servers share the same database?**
A: No, SQLite is single-process. For multiple servers, use PostgreSQL instead.

**Q: How much data can SQLite handle?**
A: Easily millions of records. For this use case (thousands of leads), perfect.

**Q: What happens if a customer deletes and recreates?**
A: Phone number is unique key. They'll show as existing customer with history.

## Next Steps

- Monitor database size on Railway dashboard
- Set up automated backups (Railway snapshots)
- Consider archiving old leads (>6 months)
- Monitor performance as data grows

---

**Version:** 5.6.0  
**Created:** October 1, 2025  
**Database:** SQLite with better-sqlite3

