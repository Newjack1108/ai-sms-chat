#!/usr/bin/env node

/**
 * Railway Deployment Script
 * This script helps deploy to Railway using the CLI
 */

const { execSync } = require('child_process');
const fs = require('fs');

console.log('🚀 Railway Deployment Script\n');

// Check if Railway CLI is installed
try {
    execSync('railway --version', { stdio: 'pipe' });
    console.log('✅ Railway CLI is installed');
} catch (error) {
    console.log('❌ Railway CLI not found. Installing...');
    try {
        execSync('npm install -g @railway/cli', { stdio: 'inherit' });
        console.log('✅ Railway CLI installed successfully');
    } catch (installError) {
        console.log('❌ Failed to install Railway CLI');
        process.exit(1);
    }
}

// Check authentication
try {
    execSync('railway whoami', { stdio: 'pipe' });
    console.log('✅ Authenticated with Railway');
} catch (error) {
    console.log('❌ Not authenticated with Railway');
    console.log('Please run: railway login');
    console.log('Then run this script again.');
    process.exit(1);
}

// Check if project is linked
try {
    execSync('railway status', { stdio: 'pipe' });
    console.log('✅ Project is linked to Railway');
} catch (error) {
    console.log('⚠️  Project not linked to Railway');
    console.log('Please run: railway link');
    console.log('Then run this script again.');
    process.exit(1);
}

// Deploy
console.log('\n🚀 Deploying to Railway...');
try {
    execSync('railway up', { stdio: 'inherit' });
    console.log('✅ Deployment successful!');
} catch (error) {
    console.log('❌ Deployment failed');
    process.exit(1);
}

console.log('\n📋 Next steps:');
console.log('1. Check your Railway dashboard for the deployment URL');
console.log('2. Update your Twilio webhook URL to: https://your-app.railway.app/webhook/sms');
console.log('3. Test by sending an SMS to your Twilio number');
