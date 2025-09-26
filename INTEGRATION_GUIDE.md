# 🔗 Integration Setup Guide

## 📱 Facebook Lead Ads Integration

### Step 1: Get Your Webhook URL
1. Go to your SMS system settings
2. Copy the Facebook webhook URL from the integration section
3. URL format: `https://your-domain.com/api/import-lead`

### Step 2: Configure Facebook Lead Ads
1. Go to Facebook Business Manager
2. Navigate to **Lead Ads** → **Webhooks**
3. Click **Add Webhook**
4. Paste your webhook URL
5. Select **Lead** as the subscription type
6. Map the following fields:
   - `name` → Lead's name
   - `phone` → Phone number
   - `email` → Email address
   - `postcode` → Postcode/ZIP code

### Step 3: Test the Integration
1. Create a test lead ad
2. Submit a test lead
3. Check your SMS system for the new customer record

---

## 📝 Gravity Forms Integration

### Step 1: Get Your Webhook URL
1. Go to your SMS system settings
2. Copy the Gravity Forms webhook URL
3. URL format: `https://your-domain.com/api/import-lead`

### Step 2: Configure Gravity Forms Webhook
1. Go to **Gravity Forms** → **Settings** → **Webhooks**
2. Click **Add New Webhook**
3. Configure the webhook:
   - **Name**: SMS System Integration
   - **Request URL**: Paste your webhook URL
   - **Request Method**: POST
   - **Request Format**: JSON

### Step 3: Map Form Fields
Map your form fields to the API fields:
```json
{
  "name": "{Name:1}",
  "phone": "{Phone:2}",
  "email": "{Email:3}",
  "postcode": "{Postcode:4}",
  "source": "gravity_form",
  "sourceDetails": {
    "formId": 1,
    "formTitle": "Stable Inquiry Form"
  }
}
```

### Step 4: Test the Integration
1. Submit a test form
2. Check your SMS system for the new customer record

---

## 📱 Twilio SMS Webhook Setup

### Step 1: Get Your Webhook URL
1. Go to your SMS system settings
2. Copy the SMS webhook URL
3. URL format: `https://your-domain.com/webhook/sms`

### Step 2: Configure Twilio
1. Go to [Twilio Console](https://console.twilio.com)
2. Navigate to **Phone Numbers** → **Manage** → **Active Numbers**
3. Click on your SMS-enabled phone number
4. In the **Messaging** section:
   - **Webhook URL**: Paste your webhook URL
   - **HTTP Method**: POST
5. Click **Save Configuration**

### Step 3: Test the Webhook
1. Send an SMS to your Twilio number
2. Check your SMS system for the incoming message
3. Verify AI response is sent back

---

## 🧪 Testing Your Integrations

### Test Integration Button
Use the **"Test Integration"** button in your settings to:
1. Send a test lead to your system
2. Verify the API is working
3. Check customer database creation

### Integration Status
The status badges show:
- **Connected/Active**: Integration is working
- **Not Connected**: Integration needs setup

### Troubleshooting

#### Facebook Lead Ads Not Working
- Check webhook URL is correct
- Verify Facebook webhook is active
- Check server logs for errors

#### Gravity Forms Not Working
- Verify webhook URL and method
- Check field mapping is correct
- Test with a simple form first

#### SMS Webhook Not Working
- Verify Twilio webhook URL
- Check Twilio phone number configuration
- Test with a simple SMS

---

## 📊 Expected Data Flow

### Facebook/Gravity Forms → SMS System
```
Lead Submitted → Webhook → Customer Created → SMS Sent → AI Chat Starts
```

### SMS Response Flow
```
SMS Received → AI Response Generated → SMS Sent Back → Customer Updated
```

### Data Collection
```
AI Chat → Progressive Data Collection → Customer Profile Complete → Sales Qualified
```

---

## 🔧 Advanced Configuration

### Custom Field Mapping
You can customize the field mapping by modifying the webhook payload:

```json
{
  "name": "Customer Name",
  "phone": "+1234567890",
  "email": "customer@example.com",
  "postcode": "12345",
  "source": "facebook",
  "sourceDetails": {
    "campaign": "spring_stables",
    "adset": "horse_owners",
    "customField1": "value1"
  },
  "customData": {
    "horseCount": "3",
    "stableType": "American barn",
    "budget": "£20,000"
  }
}
```

### Environment Variables
Make sure these are set in your `.env` file:
```env
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_FROM_NUMBER=your_twilio_number
OPENAI_API_KEY=your_openai_key
OPENAI_ASSISTANT_ID=your_assistant_id
```

---

## 📞 Support

If you need help with integration setup:
1. Check the server logs for errors
2. Use the test integration button
3. Verify all webhook URLs are accessible
4. Contact your development team

**🎯 Your CRM-integrated SMS system is now ready to capture and convert leads automatically!**

