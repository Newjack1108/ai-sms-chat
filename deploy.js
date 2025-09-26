#!/usr/bin/env node

/**
 * Deployment Helper Script
 * This script helps prepare your application for deployment
 */

const fs = require('fs');
const path = require('path');

console.log('🚀 AI SMS Chat System - Deployment Helper\n');

// Check if required files exist
const requiredFiles = [
    'package.json',
    'server.js',
    'public/index.html',
    'env.example'
];

console.log('📋 Checking required files...');
requiredFiles.forEach(file => {
    if (fs.existsSync(file)) {
        console.log(`✅ ${file}`);
    } else {
        console.log(`❌ ${file} - MISSING`);
    }
});

console.log('\n📝 Next Steps:');
console.log('1. Choose a deployment platform:');
console.log('   - Railway: https://railway.app (Recommended)');
console.log('   - Render: https://render.com');
console.log('   - Heroku: https://heroku.com');
console.log('   - DigitalOcean: https://digitalocean.com');

console.log('\n2. Set up your repository:');
console.log('   - Push your code to GitHub');
console.log('   - Connect your GitHub account to your chosen platform');

console.log('\n3. Configure environment variables:');
console.log('   - TWILIO_ACCOUNT_SID');
console.log('   - TWILIO_AUTH_TOKEN');
console.log('   - OPENAI_API_KEY');
console.log('   - OPENAI_ASSISTANT_ID');

console.log('\n4. After deployment:');
console.log('   - Get your public URL (e.g., https://your-app.railway.app)');
console.log('   - Update Twilio webhook to: https://your-app.railway.app/webhook/sms');
console.log('   - Test by sending an SMS to your Twilio number');

console.log('\n📖 See DEPLOYMENT_GUIDE.md for detailed instructions');

// Check if .env exists
if (!fs.existsSync('.env')) {
    console.log('\n⚠️  No .env file found. Copy env.example to .env and fill in your values.');
}
