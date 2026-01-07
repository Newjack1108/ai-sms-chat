# Railway Setup Guide for Box Control Dashboard

## Using the Same Database as ai-sms-chat

**Yes, it's safe to use the same PostgreSQL database!** The Box Control Dashboard uses different table names to avoid conflicts:

- `box_control_settings` (not `settings` - to avoid conflict with ai-sms-chat)
- `sales_weekly`
- `production_weekly`

The ai-sms-chat app uses:
- `leads`
- `messages`
- `settings` (key-value pairs)
- `lead_sources`

No conflicts will occur.

## Railway Environment Variables Setup

### Step 1: Add the Box Control Dashboard Service

1. In your Railway project, click **"New"** → **"GitHub Repo"** (or **"Empty Project"**)
2. If using GitHub, select your repository
3. Set the **Root Directory** to `box-control-dashboard` (if deploying from the same repo)
4. Or create a separate Railway service for the dashboard

### Step 2: Connect to Existing PostgreSQL Database

1. In your Railway project, you should already have a PostgreSQL database (from ai-sms-chat)
2. In the Box Control Dashboard service, click **"Variables"** tab
3. Click **"Reference Variable"**
4. Select your PostgreSQL service
5. Select `DATABASE_URL` from the dropdown
6. This will automatically set `DATABASE_URL` to point to your existing database

### Step 3: Set Required Environment Variables

In the Box Control Dashboard service **Variables** tab, add:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | (Reference from PostgreSQL service) | Automatically set when you reference the database |
| `APP_PASSCODE` | `your-secure-passcode-here` | **Required for production** - choose a strong passcode |
| `SESSION_SECRET` | `your-random-secret-string` | **Required** - generate a random string (e.g., use `openssl rand -hex 32`) |
| `NODE_ENV` | `production` | Set to production mode |
| `PORT` | (Leave empty) | Railway sets this automatically |

### Step 4: Generate a Secure SESSION_SECRET

Run this command to generate a secure session secret:
```bash
openssl rand -hex 32
```

Or use an online generator, then copy the result into Railway's `SESSION_SECRET` variable.

### Step 5: Deploy

1. Railway will automatically detect the Node.js project
2. It will run `npm install` and `npm start`
3. The database schema will be automatically initialized on first run
4. Your app will be available at the Railway-provided URL

## Verification

After deployment:

1. Visit your Railway URL
2. You should see the login page (if `APP_PASSCODE` is set)
3. Enter your passcode to access the dashboard
4. The database tables will be created automatically on first access

## Important Notes

- ✅ **Safe to share database**: Different table names prevent conflicts
- ✅ **Same DATABASE_URL**: Both apps can use the same connection string
- ⚠️ **Different settings tables**: ai-sms-chat uses `settings` (key-value), Box Control uses `box_control_settings` (structured)
- ⚠️ **APP_PASSCODE required**: Don't leave this empty in production
- ⚠️ **SESSION_SECRET required**: Use a strong random string

## Troubleshooting

### Database Connection Issues
- Verify `DATABASE_URL` is correctly referenced
- Check PostgreSQL service is running
- Ensure both services are in the same Railway project

### Authentication Not Working
- Verify `APP_PASSCODE` is set
- Check `SESSION_SECRET` is set
- Clear browser cookies and try again

### Tables Not Created
- Check Railway logs for database errors
- Verify `DATABASE_URL` has proper permissions
- The schema initializes automatically on first server start

