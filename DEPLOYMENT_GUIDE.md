# Deployment Guide for AI SMS Chat System

## Quick Deployment Options

### Option 1: Railway (Recommended)

1. **Sign up at [Railway.app](https://railway.app)**
2. **Connect your GitHub account**
3. **Create a new project from GitHub**
4. **Select this repository**
5. **Railway will automatically detect it's a Node.js app**
6. **Add environment variables** (see below)
7. **Deploy!**

### Option 2: Render

1. **Sign up at [Render.com](https://render.com)**
2. **Create a new Web Service**
3. **Connect your GitHub repository**
4. **Use these settings:**
   - Build Command: `npm install`
   - Start Command: `npm start`
5. **Add environment variables** (see below)
6. **Deploy!**

## Environment Variables to Set

You'll need to set these environment variables in your deployment platform:

```
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
OPENAI_API_KEY=your_openai_api_key
OPENAI_ASSISTANT_ID=your_openai_assistant_id
PORT=3000
```

## After Deployment

1. **Get your public URL** (e.g., `https://your-app.railway.app`)
2. **Update Twilio webhook URL** to: `https://your-app.railway.app/webhook/sms`
3. **Test the webhook** by sending an SMS to your Twilio number

## Testing the Deployment

1. **Visit your deployed URL** in a browser
2. **Login as admin** (admin/admin123)
3. **Configure your Twilio settings** in the Settings tab
4. **Send a test SMS** to your Twilio number
5. **Check if the webhook receives it**

## Troubleshooting

- **Check logs** in your deployment platform
- **Verify environment variables** are set correctly
- **Test webhook URL** manually with a tool like Postman
- **Check Twilio console** for webhook delivery status
