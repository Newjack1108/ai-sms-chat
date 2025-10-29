# External Platform Integration Guide

This guide explains how to integrate your AI SMS Chat system with external platforms like Facebook Lead Ads and Gravity Forms to automatically import leads.

## Overview

The system provides a `/api/leads/reactivate` endpoint that accepts leads from external sources. When a lead is submitted:
1. The system checks if the phone number already exists
2. If the lead exists and is archived, it unarchives and unpauses AI
3. If the lead is new, it creates a new lead entry
4. The SMS AI automatically begins the qualification conversation

---

## Facebook Lead Ads Integration

### Step 1: Create Your Lead Ad Campaign
1. Go to Facebook Ads Manager
2. Create a new campaign with the objective "Lead Generation"
3. Design your lead form to collect:
   - **Name** (required)
   - **Email** (required)
   - **Phone** (required)

### Step 2: Set Up Webhook in Facebook
1. Go to your Facebook App Dashboard: https://developers.facebook.com/apps
2. Navigate to **Webhooks** in the left sidebar
3. Click **"Subscribe to Page"**
4. Select your Facebook Page
5. Subscribe to the **"leadgen"** event

### Step 3: Configure Webhook URL
Set your webhook URL to:
```
https://your-railway-url.up.railway.app/api/leads/reactivate
```

**Important:** You'll need to handle Facebook's webhook verification. Add this endpoint to your `server.js`:

```javascript
// Facebook webhook verification
app.get('/api/leads/reactivate', (req, res) => {
    const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN || 'your_verify_token';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Facebook webhook handler
app.post('/api/leads/reactivate', async (req, res) => {
    try {
        const { entry } = req.body;
        
        if (entry && entry[0] && entry[0].changes) {
            const change = entry[0].changes[0];
            const leadgenId = change.value.leadgen_id;
            
            // Fetch lead data from Facebook Graph API
            const fbResponse = await fetch(
                `https://graph.facebook.com/v18.0/${leadgenId}?access_token=${process.env.FACEBOOK_ACCESS_TOKEN}`
            );
            const leadData = await fbResponse.json();
            
            // Extract fields
            const name = leadData.field_data.find(f => f.name === 'full_name')?.values[0];
            const email = leadData.field_data.find(f => f.name === 'email')?.values[0];
            const phone = leadData.field_data.find(f => f.name === 'phone_number')?.values[0];
            
            // Process lead using your existing reactivate logic
            // (see the existing /api/leads/reactivate endpoint code)
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing Facebook lead:', error);
        res.sendStatus(500);
    }
});
```

### Step 4: Environment Variables
Add to your Railway environment variables:
```
FACEBOOK_VERIFY_TOKEN=your_secret_verify_token
FACEBOOK_ACCESS_TOKEN=your_facebook_page_access_token
```

---

## Gravity Forms Integration (WordPress)

### Step 1: Install Required Plugin
1. Install and activate **Gravity Forms Webhooks Add-On**
2. Or use Zapier/Make.com as middleware

### Step 2: Configure Webhook in Gravity Forms

#### Method A: Using Gravity Forms Webhooks Add-On
1. Go to **Forms** → Select your form → **Settings** → **Webhooks**
2. Add a new webhook with these settings:
   - **Name:** AI SMS Lead Qualifier
   - **Request URL:** `https://your-railway-url.up.railway.app/api/leads/reactivate`
   - **Request Method:** POST
   - **Request Format:** JSON

3. Map your form fields:
```json
{
  "name": "{Name:1}",
  "email": "{Email:2}",
  "phone": "{Phone:3}",
  "source": "gravity_forms"
}
```

4. **Conditional Logic:** Send on "Form is submitted"

#### Method B: Using Zapier
1. Create a new Zap
2. **Trigger:** Gravity Forms → New Entry
3. **Action:** Webhooks by Zapier → POST
4. **URL:** `https://your-railway-url.up.railway.app/api/leads/reactivate`
5. **Payload Type:** JSON
6. **Data:**
   ```json
   {
     "name": "[Name from Gravity Forms]",
     "email": "[Email from Gravity Forms]",
     "phone": "[Phone from Gravity Forms]",
     "source": "gravity_forms"
   }
   ```

### Step 3: Test the Integration
1. Submit a test form entry
2. Check your Railway logs for the incoming webhook
3. Verify the lead appears in your dashboard
4. Confirm the SMS qualification conversation starts

---

## API Endpoint Reference

### POST `/api/leads/reactivate`

Reactivates an existing lead or creates a new one from an external source.

**Request Body:**
```json
{
  "phone": "+447809505864",
  "name": "John Smith",
  "email": "john@example.com",
  "source": "facebook_leads"
}
```

**Fields:**
- `phone` (required): Customer phone number (any format, will be normalized)
- `name` (optional): Customer name (defaults to "Unknown")
- `email` (optional): Customer email (defaults to empty)
- `source` (optional): Source identifier (e.g., "facebook_leads", "gravity_forms", "external")

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Lead reactivated successfully",
  "leadId": 42,
  "action": "reactivated"
}
```

OR if new lead:
```json
{
  "success": true,
  "message": "New lead created successfully",
  "leadId": 43,
  "action": "created"
}
```

**Behavior:**
- If lead exists (active): Unpauses AI, updates contact time, keeps existing answers
- If lead exists (archived): Unarchives, unpauses AI, updates contact time
- If lead is new: Creates new lead, AI starts qualification conversation
- Phone numbers are automatically normalized (UK/US formats supported)

---

## Testing Your Webhooks

### Test with cURL
```bash
curl -X POST https://your-railway-url.up.railway.app/api/leads/reactivate \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+447809505864",
    "name": "Test Customer",
    "email": "test@example.com",
    "source": "test"
  }'
```

### Test with Postman
1. Create a new POST request
2. URL: `https://your-railway-url.up.railway.app/api/leads/reactivate`
3. Headers: `Content-Type: application/json`
4. Body (raw JSON):
```json
{
  "phone": "+447809505864",
  "name": "Test Customer",
  "email": "test@example.com",
  "source": "postman_test"
}
```

---

## Troubleshooting

### Lead Not Appearing
1. Check Railway logs: `railway logs`
2. Verify phone number format (must include country code)
3. Ensure webhook URL is correct and accessible
4. Check Railway environment variables are set

### SMS Not Sending
1. Verify Twilio credentials in Railway environment variables
2. Check lead status in dashboard - AI might be paused
3. Review Rails logs for Twilio errors
4. Ensure phone number is valid and SMS-capable

### Duplicate Leads
- The system automatically handles duplicates by phone number
- Existing leads are reactivated, not duplicated
- Check database with: `GET /api/database/status`

---

## Advanced Configuration

### Custom Source Tracking
Use the `source` field to track where leads come from:
- `facebook_leads` - Facebook Lead Ads
- `gravity_forms` - Gravity Forms submissions
- `manual` - Manually added via dashboard
- `inbound_sms` - Direct SMS to your Twilio number
- `external` - Other external sources

### Webhook Security
For production, add webhook signature verification:
1. Generate a secret token
2. Add to your external platform
3. Verify signatures in your webhook handler

---

## Support

For issues or questions:
1. Check Railway logs: `railway logs`
2. Test endpoint: `GET /api/config/status`
3. Database status: `GET /api/database/status`
4. Review this guide and your platform's webhook documentation

