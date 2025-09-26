#!/usr/bin/env node

// Setup script for CRM-Integrated SMS System
const fs = require('fs');
const path = require('path');

console.log('🎯 CRM-Integrated SMS System Setup');
console.log('=====================================\n');

// Check if .env file exists
const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, 'env.example');

if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
        console.log('📝 Creating .env file from template...');
        fs.copyFileSync(envExamplePath, envPath);
        console.log('✅ .env file created! Please edit it with your API keys.\n');
    } else {
        console.log('⚠️  env.example file not found. Creating basic .env file...');
        const basicEnv = `# CRM-Integrated SMS System Environment Variables
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
TWILIO_FROM_NUMBER=your_twilio_phone_number_here
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_ASSISTANT_ID=your_openai_assistant_id_here
PORT=3000
`;
        fs.writeFileSync(envPath, basicEnv);
        console.log('✅ Basic .env file created! Please edit it with your API keys.\n');
    }
} else {
    console.log('✅ .env file already exists.\n');
}

// Check if customers.json exists
const customersPath = path.join(__dirname, 'customers.json');
if (!fs.existsSync(customersPath)) {
    console.log('📊 Creating empty customer database...');
    fs.writeFileSync(customersPath, JSON.stringify([], null, 2));
    console.log('✅ Customer database initialized!\n');
} else {
    console.log('✅ Customer database already exists.\n');
}

// Check Node.js version
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

if (majorVersion < 16) {
    console.log('⚠️  Warning: Node.js version 16 or higher is recommended.');
    console.log(`   Current version: ${nodeVersion}\n`);
} else {
    console.log(`✅ Node.js version ${nodeVersion} is compatible.\n`);
}

console.log('🚀 Setup Complete!');
console.log('==================');
console.log('Next steps:');
console.log('1. Edit .env file with your API keys');
console.log('2. Run: npm install');
console.log('3. Run: npm start');
console.log('4. Open: http://localhost:3000');
console.log('\n🔑 Default login credentials:');
console.log('   Admin: admin / admin123');
console.log('   Sales: sales / sales123');
console.log('   Manager: manager / manager123');
console.log('\n📚 See README.md for detailed setup instructions.');

