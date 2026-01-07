# Railway Deployment Steps - Box Control Dashboard

## Step-by-Step Guide

### Step 1: Create New Service in Railway

1. **Go to your Railway project** (the one with ai-sms-chat)
   - Visit [railway.app](https://railway.app)
   - Open your existing project

2. **Add a new service:**
   - Click the **"+"** button or **"New"** button in your project
   - Select **"GitHub Repo"** (if your code is on GitHub)
     - OR select **"Empty Service"** if deploying manually

3. **If using GitHub:**
   - Select your repository (same one as ai-sms-chat)
   - Railway will detect it as a Node.js project
   - **Important:** After connecting, go to **Settings** → **Root Directory**
   - Set Root Directory to: `box-control-dashboard`
   - This tells Railway to deploy from that subdirectory

4. **If using Empty Service:**
   - You'll need to connect it to your repo manually
   - Or use Railway CLI to deploy

### Step 2: Connect to Existing Database

1. In your **Box Control Dashboard** service, go to the **"Variables"** tab

2. Click **"New Variable"** → **"Reference Variable"**

3. Select your **PostgreSQL service** (the one used by ai-sms-chat)

4. Select **`DATABASE_URL`** from the dropdown

5. Click **"Add"**

   This will automatically set `DATABASE_URL` to point to your existing database.

### Step 3: Set Environment Variables

Still in the **Variables** tab, add these variables:

#### Required Variables:

1. **APP_PASSCODE**
   - Click **"New Variable"**
   - Name: `APP_PASSCODE`
   - Value: `your-secure-passcode-here` (choose a strong passcode)
   - Click **"Add"**

2. **SESSION_SECRET**
   - Click **"New Variable"**
   - Name: `SESSION_SECRET`
   - Value: Generate one using:
     ```bash
     openssl rand -hex 32
     ```
     Or use an online generator
   - Click **"Add"**

3. **NODE_ENV**
   - Click **"New Variable"**
   - Name: `NODE_ENV`
   - Value: `production`
   - Click **"Add"**

#### Optional (Auto-set by Railway):
- `PORT` - Railway sets this automatically, don't override

### Step 4: Deploy

1. Railway will automatically:
   - Detect the Node.js project
   - Run `npm install`
   - Run `npm start` (from package.json)
   - Initialize the database schema on first run

2. **Check the Deployments tab** to see the build progress

3. **Check the Logs tab** to verify:
   - ✅ Database connection successful
   - ✅ Database schema initialized
   - ✅ Server running on port XXXX

### Step 5: Get Your URL

1. Go to the **Settings** tab of your Box Control Dashboard service
2. Under **"Domains"**, Railway provides a public URL
3. Click to copy the URL (e.g., `box-control-dashboard-production.up.railway.app`)

### Step 6: Test the Deployment

1. Visit your Railway URL
2. You should see the **login page** (if `APP_PASSCODE` is set)
3. Enter your passcode
4. You should see the **Dashboard**

## Quick Checklist

- [ ] Created new service in Railway project
- [ ] Set Root Directory to `box-control-dashboard` (if in same repo)
- [ ] Referenced `DATABASE_URL` from PostgreSQL service
- [ ] Set `APP_PASSCODE` variable
- [ ] Set `SESSION_SECRET` variable
- [ ] Set `NODE_ENV=production`
- [ ] Service deployed successfully
- [ ] Can access login page at Railway URL
- [ ] Can log in with passcode
- [ ] Dashboard loads correctly

## Troubleshooting

### Service won't start
- Check **Logs** tab for errors
- Verify `DATABASE_URL` is correctly referenced
- Ensure `package.json` has correct start script

### Database connection fails
- Verify PostgreSQL service is running
- Check `DATABASE_URL` variable is set
- Check both services are in the same Railway project

### Can't access the app
- Check the **Settings** → **Domains** for the public URL
- Verify the service is deployed (green status)
- Check **Logs** for any startup errors

### Authentication not working
- Verify `APP_PASSCODE` is set in Variables
- Verify `SESSION_SECRET` is set
- Clear browser cookies and try again

## Environment Variables Summary

| Variable | Source | Required |
|----------|--------|----------|
| `DATABASE_URL` | Reference from PostgreSQL | ✅ Yes |
| `APP_PASSCODE` | Manual entry | ✅ Yes |
| `SESSION_SECRET` | Manual entry | ✅ Yes |
| `NODE_ENV` | Manual entry (`production`) | Recommended |
| `PORT` | Auto-set by Railway | No |

That's it! Your Box Control Dashboard should now be running on Railway.

