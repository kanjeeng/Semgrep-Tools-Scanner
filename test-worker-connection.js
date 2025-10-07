require('dotenv').config();
console.log('MONGO_URI:', process.env.MONGO_URI);

const database = require('./src/config/database');

async function test() {
  try {
    await database.connect();
    console.log('✅ Worker can connect to MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Worker connection failed:', error.message);
    process.exit(1);
  }
}

test();