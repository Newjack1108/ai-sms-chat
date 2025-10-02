# Railway PostgreSQL Setup Guide

## 🚀 **Quick Fix for Database Persistence**

Your database is being lost on deployments because Railway doesn't have persistent file storage by default. Here's how to fix it with PostgreSQL:

## 📋 **Step 1: Add PostgreSQL to Railway**

1. **Go to your Railway project dashboard**
2. **Click "New" → "Database" → "PostgreSQL"**
3. **Wait for PostgreSQL to be created** (takes 1-2 minutes)
4. **Copy the DATABASE_URL** from the PostgreSQL service

## 📋 **Step 2: Add Environment Variable**

1. **Go to your main service** (not the PostgreSQL service)
2. **Click "Variables" tab**
3. **Add new variable:**
   - **Name:** `DATABASE_URL`
   - **Value:** Paste the DATABASE_URL from PostgreSQL service
4. **Click "Add"**

## 📋 **Step 3: Redeploy**

1. **Push any change** to trigger a new deployment
2. **Check the logs** - you should see:
   ```
   🗄️ Using PostgreSQL database (Railway)
   ✅ PostgreSQL database initialized
   ```

## ✅ **What This Fixes**

- **✅ True persistence** - Data survives deployments
- **✅ Better performance** - PostgreSQL is faster than SQLite
- **✅ Automatic backups** - Railway backs up PostgreSQL
- **✅ Scalability** - Can handle more data and users

## 🧪 **Testing**

After setup:
1. **Create a test customer**
2. **Send some messages**
3. **Redeploy the app**
4. **Check if customer and messages are still there**

## 🔍 **If You See Errors**

- **"PostgreSQL not available"** → DATABASE_URL not set correctly
- **"Connection failed"** → Check the DATABASE_URL format
- **"Permission denied"** → Railway PostgreSQL might still be starting

## 💡 **Alternative: Quick Test**

If you want to test without PostgreSQL first:
1. **Add this environment variable:**
   - **Name:** `DATABASE_PATH`
   - **Value:** `/app/leads.db`
2. **Redeploy and test**

This uses the app directory which might persist better than /tmp.

---

**The PostgreSQL solution is the best long-term fix for true persistence!** 🎯
