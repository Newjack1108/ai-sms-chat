# Box Control Dashboard

Production-ready web application for tracking manufacturing KPIs with weekly sales and production data entry, dashboard metrics, and configurable business targets.

## Quick Start

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```env
DATABASE_URL=postgresql://user:password@localhost:5432/box_control
APP_PASSCODE=your-secure-passcode
SESSION_SECRET=your-random-secret
PORT=3000
NODE_ENV=development
```

3. Start the server:
```bash
npm start
```

### Railway Deployment

1. Connect your GitHub repository to Railway
2. Add a PostgreSQL database service
3. Set environment variables:
   - `DATABASE_URL` (auto-set from PostgreSQL service)
   - `APP_PASSCODE` (your secure passcode)
   - `SESSION_SECRET` (random secret string)
   - `NODE_ENV=production`
4. Deploy!

The database schema will be automatically initialized on first run.

## Features

- Dashboard with RAG status indicators
- Weekly sales data entry
- Weekly production data entry
- Configurable business targets
- MTD and rolling 4-week metrics
- Forward look projections

## Tech Stack

- Node.js 20+
- Express.js
- PostgreSQL
- EJS templates


