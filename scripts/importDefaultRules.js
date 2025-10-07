#!/usr/bin/env node

require('dotenv').config();
const database = require('../src/config/database');
const ruleService = require('../src/services/ruleService');

async function importDefaultRules() {
  console.log('📥 Importing default rules...\n');

  try {
    // Connect to database
    await database.connect();

    // Load default rules
    await ruleService.loadDefaultRules();

    console.log('✅ Default rules imported successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to import default rules:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  importDefaultRules();
}

module.exports = importDefaultRules;