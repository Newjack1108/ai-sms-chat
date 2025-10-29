# 🧪 Test Mode Guide

## 🎯 What is Test Mode?

Test Mode allows you to test your AI assistant and SMS system without actually sending SMS messages through Twilio. This is perfect while waiting for Twilio account verification!

## ✅ What Test Mode Does

### **Enabled Features:**
- ✅ **AI Response Generation** - Your OpenAI Assistant still works
- ✅ **Conversation Management** - Messages are stored and displayed
- ✅ **Customer Database** - Customer records are still created/updated
- ✅ **Message Templates** - All templates work normally
- ✅ **Chat Interface** - Full chat functionality

### **Disabled Features:**
- ❌ **SMS Sending** - No actual SMS messages sent via Twilio
- ❌ **Twilio API Calls** - No charges or API usage

## 🚀 How to Enable Test Mode

### Step 1: Access Settings
1. Login as **Admin** (admin / admin123)
2. Go to **Settings & Configuration** tab
3. Scroll to **AI Configuration** section

### Step 2: Enable Test Mode
1. Find **"Test Mode (No SMS Sending)"** toggle
2. Check the box to enable
3. Click **"Save Settings"** button

### Step 3: Test Mode Section Appears
Once enabled, you'll see a new **"Test Mode"** section with:
- **Simulate Incoming SMS** tool
- **Test Status** indicators
- **Test Mode Info** panel

## 🧪 Testing Your AI Assistant

### Method 1: Simulate Incoming SMS
1. Go to **Test Mode** section
2. Enter a phone number (e.g., +1234567890)
3. Type a test message (e.g., "Hi, I'm interested in stables")
4. Click **"Simulate SMS"** button
5. Watch the AI response appear!

### Method 2: Use Chat Interface
1. Go to **Chat Interface** tab
2. Enter a phone number in the recipient field
3. Type a message and send
4. The message will be added to conversation (no SMS sent)
5. AI will respond if enabled

## 📊 Test Status Indicators

The test mode shows real-time status:

| Status | Meaning |
|--------|---------|
| **Test Mode: Enabled** | Test mode is active |
| **AI Responses: Enabled** | AI will generate responses |
| **SMS Sending: Disabled (Test Mode)** | No SMS will be sent |

## 💡 Test Message Examples

Try these messages to test different scenarios:

### **Initial Contact**
```
"Hi, I'm interested in building stables for my horses"
```

### **Question Answering**
```
"I have 3 horses and need American barn style stables"
```

### **Budget Inquiry**
```
"What's the cost for a 4-stall stable?"
```

### **Timeline Question**
```
"I need the stables completed by spring"
```

## 🔧 Troubleshooting

### **AI Not Responding**
- Check OpenAI API Key is entered
- Verify Assistant ID is correct
- Ensure AI is enabled in settings
- Check browser console for errors

### **Test Mode Not Working**
- Make sure Test Mode is enabled
- Refresh the page
- Check localStorage in browser dev tools

### **Messages Not Appearing**
- Check if chat manager is initialized
- Verify phone number format
- Look for JavaScript errors in console

## 🎯 What to Test

### **Core Functionality**
- [ ] AI responses are generated
- [ ] Messages appear in chat interface
- [ ] Customer records are created
- [ ] Conversation history is maintained

### **AI Assistant Quality**
- [ ] Responses are relevant and helpful
- [ ] Assistant asks qualifying questions
- [ ] Responses are SMS-appropriate length
- [ ] Tone is professional and friendly

### **Data Collection**
- [ ] Customer information is extracted
- [ ] Questions are answered and stored
- [ ] Conversation stages progress correctly
- [ ] Customer database updates properly

## 🔄 Switching Back to Live Mode

When Twilio verification is complete:

1. Go to **Settings & Configuration**
2. Uncheck **"Test Mode (No SMS Sending)"**
3. Click **"Save Settings"**
4. Your system will now send real SMS messages!

## 📱 Testing with Real SMS (After Verification)

Once Twilio is verified:
1. Disable Test Mode
2. Configure Twilio webhook: `https://your-domain.com/webhook/sms`
3. Send SMS to your Twilio number
4. Verify AI responses are sent back

## 🆘 Support

If you need help with test mode:
1. Check browser console for errors
2. Verify all API keys are correct
3. Test with simple messages first
4. Contact your development team

**🎯 Test Mode lets you perfect your AI assistant before going live!**














