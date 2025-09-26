# 🌐 CORS Setup for OpenAI API

## ⚠️ Important Note

The AI response generation now calls the OpenAI API directly from the frontend. This may cause CORS (Cross-Origin Resource Sharing) issues in some browsers.

## 🔧 Solutions

### Option 1: Use a CORS Proxy (Quick Fix)
If you encounter CORS errors, you can use a CORS proxy service:

```javascript
// Replace the OpenAI API URL with a CORS proxy
const response = await fetch('https://cors-anywhere.herokuapp.com/https://api.openai.com/v1/chat/completions', {
    // ... rest of the code
});
```

### Option 2: Server-Side AI Endpoint (Recommended)
For production, it's better to create a server-side AI endpoint:

1. **Add to server.js:**
```javascript
app.post('/api/ai-response', async (req, res) => {
    try {
        const { message, openaiKey, aiModel } = req.body;
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: aiModel,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful AI assistant for an equine stable construction company...'
                    },
                    {
                        role: 'user',
                        content: message
                    }
                ],
                max_tokens: 150,
                temperature: 0.7
            })
        });

        if (response.ok) {
            const data = await response.json();
            res.json({ success: true, response: data.choices[0].message.content });
        } else {
            res.status(500).json({ success: false, error: 'OpenAI API error' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
```

2. **Update frontend to use server endpoint:**
```javascript
const response = await fetch('/api/ai-response', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        message: incomingMessage,
        openaiKey: settings.openaiKey,
        aiModel: settings.aiModel
    })
});
```

### Option 3: Browser Extension
Install a CORS browser extension like "CORS Unblock" for development.

## 🧪 Testing

1. **Try the simulate SMS function**
2. **Check browser console for CORS errors**
3. **If CORS errors occur, use one of the solutions above**

## 🚀 Production Recommendation

For production deployment, use **Option 2** (server-side endpoint) as it:
- Keeps API keys secure on the server
- Avoids CORS issues
- Provides better error handling
- Allows for rate limiting and caching

**The current setup should work for testing, but may need adjustment for production!**


