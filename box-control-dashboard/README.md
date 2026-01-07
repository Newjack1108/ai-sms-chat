# Box Control Dashboard

Production-ready web application for tracking manufacturing KPIs with weekly sales and production data entry, dashboard metrics, and configurable business targets.

## Features

- **Dashboard**: Read-only summary with RAG (Red/Amber/Green) status indicators
- **Sales Input**: Weekly sales data entry form
- **Production Input**: Weekly production data entry form
- **Settings**: Configurable business targets and constants
- **Metrics**: MTD (Month-to-Date) and rolling 4-week calculations
- **Forward Look**: Projection for next 4 weeks

## Tech Stack

- Node.js 20+
- Express.js
- PostgreSQL (via Railway)
- EJS templates
- Server-side rendering

## Local Development Setup

### Prerequisites

- Node.js 20 or higher
- PostgreSQL database (local or remote)
- npm or yarn

### Installation

1. Clone or navigate to the project directory:
```bash
cd box-control-dashboard
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
DATABASE_URL=postgresql://user:password@localhost:5432/box_control
APP_PASSCODE=your-secure-passcode-here
SESSION_SECRET=your-session-secret-here
PORT=3000
NODE_ENV=development
```

4. Run database migrations:
The schema will be automatically initialized on first server start. Alternatively, you can run the migration manually:
```bash
psql $DATABASE_URL -f migrations/001_init.sql
```

5. Start the development server:
```bash
npm run dev
```

Or for production mode:
```bash
npm start
```

6. Open your browser and navigate to:
- Dashboard: http://localhost:3000/dashboard
- Sales: http://localhost:3000/sales
- Production: http://localhost:3000/production

### Development Mode

If `APP_PASSCODE` is not set in the `.env` file, the application will run in development mode with authentication disabled. This is useful for local development but should never be used in production.

## Railway Deployment

### Step 1: Create Railway Project

1. Go to [Railway](https://railway.app) and sign in
2. Click "New Project"
3. Select "Deploy from GitHub repo" (recommended) or "Empty Project"

### Step 2: Add PostgreSQL Database

1. In your Railway project, click "New"
2. Select "Database" → "Add PostgreSQL"
3. Railway will automatically create a PostgreSQL database
4. The `DATABASE_URL` environment variable will be automatically set

### Step 3: Configure Environment Variables

In your Railway project settings, add the following environment variables:

- `DATABASE_URL`: Automatically set by Railway (don't override)
- `APP_PASSCODE`: Your secure passcode for authentication (required in production)
- `SESSION_SECRET`: A random secret string for session cookies (required)
- `PORT`: Railway sets this automatically (don't override)
- `NODE_ENV`: Set to `production`

### Step 4: Deploy

#### Option A: Deploy from GitHub

1. Connect your GitHub repository to Railway
2. Railway will automatically detect the Node.js project
3. Set the root directory to `box-control-dashboard` if needed
4. Railway will build and deploy automatically

#### Option B: Deploy via Railway CLI

1. Install Railway CLI:
```bash
npm i -g @railway/cli
```

2. Login to Railway:
```bash
railway login
```

3. Initialize and deploy:
```bash
cd box-control-dashboard
railway init
railway up
```

### Step 5: Verify Deployment

1. Once deployed, Railway will provide a public URL
2. Visit the URL and verify the dashboard loads
3. Test authentication with your `APP_PASSCODE`
4. Verify database connection by entering test data

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Yes | - |
| `APP_PASSCODE` | Passcode for authentication | No* | - |
| `SESSION_SECRET` | Secret for session cookies | Yes | - |
| `PORT` | Server port | No | 3000 |
| `NODE_ENV` | Environment mode | No | development |

\* If `APP_PASSCODE` is not set, authentication is disabled (dev mode only)

## Database Schema

### Tables

- **settings**: Single row containing all business constants
- **sales_weekly**: Weekly sales data entries
- **production_weekly**: Weekly production data entries

See `migrations/001_init.sql` for the complete schema.

## Project Structure

```
box-control-dashboard/
├── src/
│   ├── server.js          # Express app setup
│   ├── db.js              # PostgreSQL connection and queries
│   ├── routes/
│   │   ├── index.js       # Dashboard and settings routes
│   │   ├── sales.js       # Sales form routes
│   │   └── production.js  # Production form routes
│   └── middleware/
│       └── auth.js        # Authentication middleware
├── views/
│   ├── layout.ejs         # Base template
│   ├── dashboard.ejs      # Dashboard view
│   ├── sales.ejs          # Sales form view
│   ├── production.ejs     # Production form view
│   ├── login.ejs         # Login view
│   └── error.ejs         # Error view
├── public/
│   └── styles.css        # Stylesheet
├── migrations/
│   └── 001_init.sql      # Database schema
├── package.json
└── README.md
```

## Business Logic

### MTD (Month-to-Date) Calculation

- Sums all weekly rows where `week_commencing` falls within the current calendar month
- Uses Europe/London timezone logic

### Rolling 4 Weeks

- Gets the last 4 recorded weeks ordered by `week_commencing DESC`
- Calculates weighted averages for percentages

### RAG Status Thresholds

- **Contribution**: Red < survival, Amber >= survival & < target, Green >= target
- **Install %**: Red if < target_install_pct
- **Extras %**: Red if < target_extras_pct
- **Contribution per box**: Red < 600, Amber 600-639, Green >= 640
- **Cost compliance**: Red if < cost_compliance_target
- **Rework per box**: Red > 0.5, Amber 0.25-0.5, Green <= 0.25

## Security Considerations

- All database queries use parameterized statements to prevent SQL injection
- Passcode authentication with session cookies
- Input validation on all forms
- Secure session cookies in production mode

## Troubleshooting

### Database Connection Issues

- Verify `DATABASE_URL` is correctly set
- Check PostgreSQL is running and accessible
- Ensure database exists and migrations have run

### Authentication Not Working

- Verify `APP_PASSCODE` is set in production
- Check `SESSION_SECRET` is set
- Clear browser cookies and try again

### Port Already in Use

- Change `PORT` in `.env` file
- Or kill the process using the port

## License

MIT

## Support

For issues or questions, please check the project documentation or contact the development team.

