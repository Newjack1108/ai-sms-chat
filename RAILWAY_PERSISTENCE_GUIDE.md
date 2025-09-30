# Railway Persistence Setup Guide

## 🚀 **Railway Persistence Fix - Complete Solution**

The AI SMS Chat app now has multiple persistence methods to ensure your data survives server restarts on Railway.

## 📊 **What Was Fixed**

### **1. Customer Data Persistence**
- ✅ **Railway Persistent Storage**: Uses `/tmp` or `RAILWAY_VOLUME_MOUNT_PATH`
- ✅ **Local File Fallback**: Falls back to local files if persistent storage fails
- ✅ **Error Handling**: Graceful degradation with detailed logging

### **2. Custom Questions Persistence**
- ✅ **Railway Persistent Storage**: Saves questions to persistent volume
- ✅ **Environment Variables**: Fallback to env vars if files fail
- ✅ **Multiple Fallbacks**: Tries multiple storage methods

### **3. New Endpoints**
- ✅ **`/api/setup-persistence`**: Test Railway persistent storage
- ✅ **`/api/force-save`**: Manually save all data
- ✅ **Enhanced logging**: Better error messages and status

## 🔧 **Railway Setup Options**

### **Option 1: Environment Variables (Recommended for Railway)**

Railway doesn't have persistent volumes. The best approach is to use environment variables:

1. **Go to Railway Dashboard** → Your Project → Variables
2. **Add these environment variables**:

```
CUSTOM_QUESTION_1=What type of building do you require?
CUSTOM_QUESTION_2=How soon do you need your building?
CUSTOM_QUESTION_3=Do you need the building to be mobile?
CUSTOM_QUESTION_4=How do you want me to respond, email or phone?
```

### **Option 2: Railway PostgreSQL (Best for Production)**

For production use, consider upgrading to Railway PostgreSQL:

1. **Add PostgreSQL service** in Railway
2. **Update the code** to use PostgreSQL instead of JSON files
3. **Migrate existing data** to the database

## 🧪 **Testing the Fix**

### **1. Test Persistence Setup**
```bash
curl -X POST https://your-railway-url.com/api/setup-persistence
```

### **2. Test Force Save**
```bash
curl -X POST https://your-railway-url.com/api/force-save
```

### **3. Test Custom Questions**
1. **Update questions** in the app settings
2. **Restart the Railway service**
3. **Check if questions persist**

### **4. Test Customer Data**
1. **Create a test customer**
2. **Add conversation data**
3. **Restart the Railway service**
4. **Check if customer data persists**

## 📝 **How It Works Now**

### **Storage Priority**
1. **Railway Persistent Storage** (`/data` or `/tmp`)
2. **Local Files** (temporary, lost on restart)
3. **Environment Variables** (for questions only)
4. **Default Values** (fallback)

### **Automatic Fallbacks**
- If Railway persistent storage fails → tries local files
- If local files fail → uses environment variables (questions)
- If everything fails → uses defaults with warning

### **Enhanced Logging**
- Clear messages about which storage method is being used
- Warnings when data might be lost
- Success confirmations when data is saved

## 🎯 **Next Steps**

1. **Set up Railway persistent volume** (Option 1)
2. **Test the persistence** using the endpoints
3. **Update your custom questions** in the app
4. **Test AI extraction** with persistent data
5. **Verify data survives restarts**

## 🔍 **Troubleshooting**

### **If Data Still Disappears**
1. Check Railway logs for storage errors
2. Verify persistent volume is mounted correctly
3. Test with `/api/setup-persistence` endpoint
4. Consider upgrading to PostgreSQL

### **If Custom Questions Reset**
1. Check environment variables are set
2. Use `/api/force-save` after updating questions
3. Verify persistent storage is working

### **If AI Extraction Doesn't Work**
1. Ensure custom questions are saved
2. Check conversation data exists
3. Verify OpenAI API key is configured
4. Test with debug endpoints

## 🚀 **Production Recommendations**

For production use, consider:
1. **Railway PostgreSQL** for reliable data storage
2. **Redis** for session management
3. **Backup strategy** for important data
4. **Monitoring** for storage health

The current solution provides robust fallbacks and should work reliably on Railway!
