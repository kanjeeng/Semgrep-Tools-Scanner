require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs-extra');
const path = require('path');

// Import configurations and services
const database = require('./config/database');
const semgrepConfig = require('./config/semgrep');
const ruleService = require('./services/ruleService');

// Import routes
const rulesRoutes = require('./routes/rules');
const projectsRoutes = require('./routes/projects');
const scansRoutes = require('./routes/scans');
const webhooksRoutes = require('./routes/webhooks');

class SourceAnalyzerApp {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.apiPrefix = process.env.API_PREFIX || '/api';

    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  async initialize() {
    try {
      // Create necessary directories
      await this.createDirectories();

      // Connect to database
      await database.connect();

      // Validate Semgrep installation
      await semgrepConfig.validateInstallation();

      // Load default rules
      await ruleService.loadDefaultRules();

      console.log('✅ Source Code Analyzer initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize application:', error);
      process.exit(1);
    }
  }

  initializeMiddlewares() {
    // Security middleware
    this.app.use(helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" }
    }));

    // CORS middleware
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
      credentials: true
    }));

    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Logging middleware
    this.app.use(morgan('combined', {
      stream: fs.createWriteStream(path.join(__dirname, '../logs/access.log'), { flags: 'a' })
    }));
    
    // Also log to console in development
    if (process.env.NODE_ENV === 'development') {
      this.app.use(morgan('dev'));
    }

    // Request logging middleware
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  initializeRoutes() {
    // Health check endpoint
    this.app.get('/health', async (req, res) => {
      try {
        const dbHealth = await database.healthCheck();
        const semgrepHealth = await semgrepConfig.validateInstallation().catch(() => ({ installed: false }));

        res.json({
          status: 'ok',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          services: {
            database: dbHealth,
            semgrep: semgrepHealth
          },
          uptime: process.uptime(),
          memory: process.memoryUsage()
        });
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message
        });
      }
    });

    // API routes
    this.app.use(`${this.apiPrefix}/rules`, rulesRoutes);
    this.app.use(`${this.apiPrefix}/projects`, projectsRoutes);
    this.app.use(`${this.apiPrefix}/scans`, scansRoutes);
    this.app.use('/webhooks', webhooksRoutes);

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        message: '🔍 Source Code Analyzer API',
        version: '1.0.0',
        endpoints: {
          rules: `${this.apiPrefix}/rules`,
          projects: `${this.apiPrefix}/projects`,
          scans: `${this.apiPrefix}/scans`,
          webhooks: '/webhooks',
          health: '/health'
        },
        documentation: 'https://github.com/your-username/source-analyzer'
      });
    });

    // API info endpoint
    this.app.get(this.apiPrefix, (req, res) => {
      res.json({
        name: 'Source Code Analyzer API',
        version: '1.0.0',
        description: 'Advanced source code security and quality analysis platform',
        endpoints: {
          rules: {
            description: 'Manage Semgrep rules',
            methods: ['GET', 'POST', 'PUT', 'DELETE']
          },
          projects: {
            description: 'Manage projects and repositories',
            methods: ['GET', 'POST', 'PUT', 'DELETE']
          },
          scans: {
            description: 'Manage scan jobs and results',
            methods: ['GET', 'POST', 'PUT']
          }
        }
      });
    });
  }

  initializeErrorHandling() {
    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: `Route ${req.originalUrl} not found`
      });
    });

    // Global error handler
    this.app.use((error, req, res, next) => {
      console.error('🚨 Unhandled error:', error);

      // Log error to file
      const errorLog = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body,
        error: {
          message: error.message,
          stack: error.stack
        }
      };

      fs.appendFile(
        path.join(__dirname, '../logs/errors.log'),
        JSON.stringify(errorLog) + '\n'
      ).catch(console.error);

      res.status(error.status || 500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    });
  }

  async createDirectories() {
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
    }

    console.log('✅ Required directories created');
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`
🚀 Source Code Analyzer Server Started!
📍 Port: ${this.port}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
📊 API: http://localhost:${this.port}${this.apiPrefix}
🔧 Health: http://localhost:${this.port}/health
📨 Webhooks: http://localhost:${this.port}/webhooks/github

📋 Available Endpoints:
   GET  ${this.apiPrefix}/rules          - List all rules
   POST ${this.apiPrefix}/rules          - Create new rule
   GET  ${this.apiPrefix}/projects       - List all projects
   POST ${this.apiPrefix}/projects       - Create new project
   GET  ${this.apiPrefix}/scans          - List scan jobs
   POST /webhooks/github                 - GitHub webhook endpoint

💡 Don't forget to:
   1. Configure your .env file
   2. Start MongoDB (docker-compose up mongodb)
   3. Run the worker (npm run worker)
      `);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  async shutdown() {
    console.log('🛑 Shutting down server...');
    
    try {
      await database.close();
      console.log('✅ Database connection closed');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  }
}

// Start the application if this file is run directly
if (require.main === module) {
  const app = new SourceAnalyzerApp();
  
  app.initialize().then(() => {
    app.start();
  }).catch(error => {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  });
}

module.exports = SourceAnalyzerApp;