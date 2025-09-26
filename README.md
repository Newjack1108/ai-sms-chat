# 🎯 CRM-Integrated SMS System for Equine Stable Leads

## 🏗️ **System Architecture:**

```
Facebook/Gravity Forms → SMS System → Customer Database → Sales Pipeline
                     ↓
               AI Assistant Chat
                     ↓
            Progressive Data Collection
                     ↓
              Complete Customer Profile
```

## 🚀 **Features**

- **🔐 Role-Based Authentication** (Admin/Sales)
- **📱 SMS Chat Interface** with AI Assistant
- **📊 Customer Database** with lead tracking
- **🎯 Progressive Data Collection** through conversation
- **🔗 Facebook/Gravity Forms Integration**
- **⚙️ Configurable Questions** (Q1-Q4)
- **📈 Sales Pipeline Management**
- **🤖 OpenAI Assistant Integration**

## 📋 **Prerequisites**

- Node.js (v16 or higher)
- Twilio Account with SMS capabilities
- OpenAI API Key
- Facebook/Gravity Forms (optional)

## 🛠️ **Installation**

1. **Clone the repository:**
```bash
git clone <your-repo-url>
cd ai-sms-chat
```

2. **Install dependencies:**
```bash
npm install
```

3. **Set up environment variables:**
Create a `.env` file in the root directory:
```env
# Twilio Configuration
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=your_twilio_phone_number

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key
OPENAI_ASSISTANT_ID=your_openai_assistant_id

# Server Configuration
PORT=3000
```

4. **Start the server:**
```bash
npm start
```

5. **Access the interface:**
Open your browser to `http://localhost:3000`

## 🔑 **Default Login Credentials**

| Role | Username | Password |
|------|----------|----------|
| **Admin** | `admin` | `admin123` |
| **Sales** | `sales` | `sales123` |
| **Manager** | `manager` | `manager123` |

## 📊 **Customer Data Structure**

```javascript
Customer Record = {
    // Basic Info
    id: "cust_12345",
    name: "John Smith",
    phone: "+441234567890",
    email: "john@example.com",
    postcode: "CW1 2AB",
    
    // Lead Source
    source: "facebook" | "gravity_form" | "inbound_sms",
    sourceDetails: { campaign: "spring_stables", formId: 123 },
    
    // Custom Questions (editable)
    question1: { 
        question: "How many horses do you currently have?", 
        answer: "3 horses",
        answered: true 
    },
    question2: { 
        question: "What's your preferred stable configuration?", 
        answer: "American barn style",
        answered: true 
    },
    question3: { 
        question: "What's your budget range?", 
        answer: "£15,000 - £25,000",
        answered: false 
    },
    question4: { 
        question: "When do you need the stables completed?", 
        answer: null,
        answered: false 
    },
    
    // Chat-collected data
    chatData: {
        propertyType: "Private residence",
        landSize: "5 acres",
        planningPermission: "Not yet applied",
        currentShelter: "Field shelter only",
        specialRequirements: "Disabled access needed"
    },
    
    // Conversation tracking
    conversationStage: "qualifying",
    lastContact: "2025-09-24T10:30:00Z",
    assistantThreadId: "thread_abc123",
    priority: "high",
    status: "active"
}
```

## 🔗 **API Endpoints**

### **Lead Import**
```bash
POST /api/import-lead
Content-Type: application/json

{
    "name": "John Smith",
    "phone": "01234567890",
    "email": "john@example.com",
    "postcode": "CW1 2AB",
    "source": "gravity_form",
    "sourceDetails": {
        "formId": 123,
        "campaign": "spring_stables"
    },
    "customData": {
        "interested_in": "American barn",
        "horse_count": "3"
    }
}
```

### **Send SMS**
```bash
POST /api/send-sms
Content-Type: application/json

{
    "to": "+441234567890",
    "message": "Hello! Thanks for your interest in our stables.",
    "accountSid": "your_twilio_sid",
    "authToken": "your_twilio_token",
    "from": "your_twilio_number"
}
```

### **Customer Management**
```bash
# Get all customers
GET /api/customers

# Get specific customer
GET /api/customers/+441234567890

# Update customer
PUT /api/customers/+441234567890
Content-Type: application/json

{
    "status": "quoted",
    "priority": "high"
}
```

### **Webhook (Twilio)**
```bash
POST /webhook/sms
# Handles incoming SMS messages automatically
```

## 🔗 **Facebook/Gravity Forms Integration**

### **Gravity Forms Webhook Setup:**
1. Go to your Gravity Form settings
2. Add a new webhook
3. Set URL: `https://your-domain.com/api/import-lead`
4. Configure field mapping:
   - `name` → Name field
   - `phone` → Phone field
   - `email` → Email field
   - `postcode` → Postcode field

### **Facebook Lead Ads Integration:**
1. Set up Facebook Lead Ads webhook
2. Point to: `https://your-domain.com/api/import-lead`
3. Map Facebook fields to our API structure

## 🎛️ **Admin Features**

- **⚙️ Settings & Configuration**
  - Twilio API credentials
  - OpenAI API settings
  - AI model selection
  - Auto-response toggle

- **❓ Question Configuration**
  - Edit Q1-Q4 questions
  - Save custom questions
  - Real-time updates

- **📊 Customer Database**
  - View all customers
  - Customer statistics
  - Export capabilities
  - Search and filter

## 💼 **Sales Features**

- **💬 Chat Interface**
  - Send SMS messages
  - View conversation history
  - Use message templates
  - AI-powered responses

## 🛡️ **Security Features**

- **🔐 Role-based access control**
- **🔒 Session management**
- **⚠️ Security warnings for API tokens**
- **🚪 Secure logout functionality**

## 📱 **SMS Webhook Setup (Twilio)**

1. **Configure Twilio Webhook:**
   - Go to your Twilio Console
   - Navigate to Phone Numbers → Manage → Active Numbers
   - Click on your SMS-enabled number
   - Set webhook URL: `https://your-domain.com/webhook/sms`
   - Set HTTP method: POST

2. **Test the webhook:**
   - Send an SMS to your Twilio number
   - Check server logs for incoming messages
   - Verify AI responses are sent

## 🚀 **Deployment**

### **Heroku Deployment:**
```bash
# Install Heroku CLI
# Login to Heroku
heroku login

# Create app
heroku create your-app-name

# Set environment variables
heroku config:set TWILIO_ACCOUNT_SID=your_sid
heroku config:set TWILIO_AUTH_TOKEN=your_token
heroku config:set TWILIO_FROM_NUMBER=your_number
heroku config:set OPENAI_API_KEY=your_key
heroku config:set OPENAI_ASSISTANT_ID=your_assistant_id

# Deploy
git push heroku main
```

### **Vercel Deployment:**
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard
```

## 📊 **Monitoring & Analytics**

- **Health Check:** `GET /health`
- **Customer Statistics:** Available in admin dashboard
- **Conversation Tracking:** Automatic stage progression
- **Lead Source Analytics:** Track conversion by source

## 🔧 **Customization**

### **Adding New Questions:**
1. Go to Settings → Question Configuration
2. Edit the 4 default questions
3. Save changes
4. Questions apply to all new conversations

### **Customizing AI Responses:**
1. Create an OpenAI Assistant
2. Set system prompt for your business
3. Add assistant ID to environment variables
4. AI will use your custom instructions

### **Styling:**
- Modify CSS in `public/index.html`
- Kelly green and white theme
- Responsive design
- Professional UI

## 🆘 **Troubleshooting**

### **Common Issues:**

1. **SMS not sending:**
   - Check Twilio credentials
   - Verify phone number format
   - Check Twilio account balance

2. **AI not responding:**
   - Verify OpenAI API key
   - Check assistant ID
   - Review server logs

3. **Webhook not working:**
   - Ensure HTTPS URL
   - Check Twilio webhook configuration
   - Verify server is accessible

4. **Login issues:**
   - Use demo credentials
   - Check browser console
   - Clear browser cache

## 📞 **Support**

For technical support or customization requests, please contact your development team.

## 📄 **License**

MIT License - See LICENSE file for details.

---

**🎯 Ready to capture and convert your equine stable leads with AI-powered SMS conversations!**

