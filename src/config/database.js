const mongoose = require('mongoose');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/database.log' })
  ]
});

class Database {
  constructor() {
    this.connection = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/source_analyzer';
      
      // Updated options for newer MongoDB driver
      const options = {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        // Remove deprecated options
      };

      this.connection = await mongoose.connect(mongoUri, options);
      this.isConnected = true;

      logger.info('✅ MongoDB connected successfully');
      console.log('✅ MongoDB connected successfully');

      // Event listeners for connection
      mongoose.connection.on('error', (err) => {
        logger.error('❌ MongoDB connection error:', err);
        console.error('❌ MongoDB connection error:', err);
        this.isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('⚠️ MongoDB disconnected');
        console.warn('⚠️ MongoDB disconnected');
        this.isConnected = false;
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('✅ MongoDB reconnected');
        console.log('✅ MongoDB reconnected');
        this.isConnected = true;
      });

      // Graceful shutdown
      process.on('SIGINT', this.close.bind(this));
      process.on('SIGTERM', this.close.bind(this));

    } catch (error) {
      logger.error('❌ MongoDB connection failed:', error);
      console.error('❌ MongoDB connection failed:', error);
      process.exit(1);
    }
  }

  async close() {
    if (this.connection) {
      try {
        await mongoose.connection.close();
        logger.info('✅ MongoDB connection closed');
        console.log('✅ MongoDB connection closed');
      } catch (error) {
        logger.error('❌ Error closing MongoDB connection:', error);
        console.error('❌ Error closing MongoDB connection:', error);
      }
    }
  }

  getConnection() {
    return mongoose.connection;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      name: mongoose.connection.name
    };
  }

  // Health check
  async healthCheck() {
    try {
      if (!this.isConnected) {
        return { status: 'down', error: 'Not connected to database' };
      }

      // Run a simple query to check database responsiveness
      await mongoose.connection.db.admin().ping();
      return { status: 'up' };
    } catch (error) {
      this.isConnected = false;
      return { status: 'down', error: error.message };
    }
  }
}

module.exports = new Database();