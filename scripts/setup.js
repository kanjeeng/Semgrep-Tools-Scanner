#!/usr/bin/env node

require('dotenv').config();
const database = require('../src/config/database');
const ruleService = require('../src/services/ruleService');
const fs = require('fs-extra');
const path = require('path');

async function setup() {
  console.log('🔧 Setting up Source Code Analyzer...\n');

  try {
    // Create necessary directories
    console.log('📁 Creating directories...');
    const directories = [
      'logs',
      'temp', 
      'rules/security',
      'rules/performance',
      'rules/style',
      'rules/correctness'
    ];

    for (const dir of directories) {
      await fs.ensureDir(path.join(__dirname, '..', dir));
      console.log(`  ✅ Created ${dir}/`);
    }

    // Connect to database
    console.log('\n🗄️  Connecting to database...');
    await database.connect();

    // Load default rules
    console.log('\n📝 Loading default rules...');
    await ruleService.loadDefaultRules();

    // Validate Semgrep installation
    console.log('\n🔍 Validating Semgrep installation...');
    try {
      const semgrepConfig = require('../src/config/semgrep');
      await semgrepConfig.validateInstallation();
      console.log('  ✅ Semgrep is properly installed');
    } catch (error) {
      console.log('  ⚠️  Semgrep not found or not in PATH');
      console.log('  💡 Install with: pip install semgrep');
    }

    console.log('\n🎉 Setup completed successfully!');
    console.log('\n🚀 Next steps:');
    console.log('   1. Start the server: npm start');
    console.log('   2. Start the worker: npm run worker');
    console.log('   3. Access the API: http://localhost:3000/api');
    console.log('\n📚 Documentation: https://github.com/your-username/source-analyzer');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

// Run setup if this file is executed directly
if (require.main === module) {
  setup();
}

module.exports = setup;