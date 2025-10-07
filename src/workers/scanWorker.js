require('dotenv').config();
const database = require('../config/database');
const scanService = require('../services/scanService');
const projectService = require('../services/projectService');
const ScanJob = require('../models/ScanJob');
const nodeCron = require('node-cron');
const winston = require('winston');

// Configure logger for worker
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'scan-worker' },
  transports: [
    new winston.transports.File({ filename: 'logs/worker.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

class ScanWorker {
  constructor() {
    this.isRunning = false;
    this.scheduledTasks = new Map();
  }

  async initialize() {
    try {

      logger.info('🔧 Scan worker initializing...');
      logger.info('MONGO_URI:', process.env.MONGO_URI);

      // Connect to database
      await database.connect();
      
      logger.info('✅ MongoDB connected successfully in worker');

      // Initialize scan service
      await scanService.initialize();

      // Start processing existing pending jobs
      await this.processPendingJobs();

      // Start scheduled scans
      this.startScheduledScans();

      // Start health monitoring
      this.startHealthMonitoring();

      this.isRunning = true;
      
      logger.info('✅ Scan worker started successfully');
      
      // Graceful shutdown handler
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());

    } catch (error) {
      logger.error('❌ Failed to initialize scan worker:', error);
      process.exit(1);
    }
  }

  // Process pending jobs from previous runs
  async processPendingJobs() {
    try {
      const pendingJobs = await ScanJob.find({
        status: { $in: ['pending', 'queued', 'running'] }
      });

      logger.info(`🔄 Found ${pendingJobs.length} pending jobs to process`);

      for (const job of pendingJobs) {
        try {
          if (job.status === 'running') {
            // Mark running jobs as failed (they were interrupted)
            await job.updateStatus('failed', new Error('Worker restart interrupted this scan'));
            logger.warn(`⏹️  Marked interrupted job ${job._id} as failed`);
          } else {
            // Requeue pending jobs
            scanService.addToQueue(job);
            logger.info(`↩️  Requeued job ${job._id}`);
          }
        } catch (jobError) {
          logger.error(`❌ Failed to process job ${job._id}:`, jobError);
        }
      }
    } catch (error) {
      logger.error('❌ Failed to process pending jobs:', error);
    }
  }

  // Start scheduled scans based on project configurations
  startScheduledScans() {
    // Run every hour to check for scheduled scans
    nodeCron.schedule('0 * * * *', async () => {
      try {
        await this.executeScheduledScans();
      } catch (error) {
        logger.error('❌ Scheduled scan execution failed:', error);
      }
    });

    logger.info('⏰ Scheduled scans monitoring started');
  }

  // Execute scheduled scans
  async executeScheduledScans() {
    try {
      const projects = await projectService.getProjectsForScheduledScan();
      
      logger.info(`📅 Found ${projects.length} projects due for scheduled scan`);

      for (const project of projects) {
        try {
          // Check if project has active scheduled scans
          if (project.scan_schedule?.enabled) {
            const activeScans = await ScanJob.countDocuments({
              project_id: project._id,
              status: { $in: ['pending', 'queued', 'running'] }
            });

            if (activeScans === 0) {
              // Create scheduled scan job
              const scanJob = await scanService.createScanJob(project._id, {
                source: 'scheduled',
                event: 'scheduled_scan',
                priority: 3, // Lower priority for scheduled scans
                branch: project.branch,
                metadata: {
                  scheduled: true,
                  cron_expression: project.scan_schedule.cron_expression
                }
              });

              logger.info(`⏰ Created scheduled scan job ${scanJob._id} for ${project.name}`);
            }
          }
        } catch (projectError) {
          logger.error(`❌ Failed to create scheduled scan for ${project.name}:`, projectError);
        }
      }
    } catch (error) {
      logger.error('❌ Failed to execute scheduled scans:', error);
    }
  }

  // Start health monitoring
  startHealthMonitoring() {
    // Health check every 30 seconds
    setInterval(() => {
      this.healthCheck();
    }, 30000);

    // Cleanup old data every 6 hours
    nodeCron.schedule('0 */6 * * *', () => {
      this.cleanupOldData();
    });

    logger.info('❤️  Health monitoring started');
  }

  // Health check function
  async healthCheck() {
    try {
      const health = {
        timestamp: new Date(),
        worker: 'running',
        database: await database.healthCheck(),
        queue: {
          active: scanService.activeJobs.size,
          queued: scanService.jobQueue.length,
          max_concurrent: scanService.maxConcurrentJobs
        },
        memory: {
          used: process.memoryUsage().heapUsed / 1024 / 1024,
          total: process.memoryUsage().heapTotal / 1024 / 1024
        }
      };

      // Log health status periodically
      if (Date.now() % 300000 < 30000) { // Every ~5 minutes
        logger.info('❤️  Worker health check', health);
      }

      return health;
    } catch (error) {
      logger.error('❌ Health check failed:', error);
      return {
        timestamp: new Date(),
        worker: 'error',
        error: error.message
      };
    }
  }

  // Cleanup old data
  async cleanupOldData() {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      // Find old completed scan jobs
      const oldJobs = await ScanJob.find({
        status: 'completed',
        created_at: { $lt: thirtyDaysAgo }
      }).select('_id');

      const jobIds = oldJobs.map(job => job._id);

      if (jobIds.length > 0) {
        // Delete related scan results
        const resultDelete = await require('../models/ScanResult').deleteMany({
          job_id: { $in: jobIds }
        });

        // Delete old scan jobs
        const jobDelete = await ScanJob.deleteMany({
          _id: { $in: jobIds }
        });

        logger.info(`🧹 Cleaned up ${jobDelete.deletedCount} old scan jobs and ${resultDelete.deletedCount} results`);
      }

      // Cleanup temp directories
      await scanService.cleanupTempDirectories();

    } catch (error) {
      logger.error('❌ Data cleanup failed:', error);
    }
  }

  // Graceful shutdown
  async shutdown() {
    if (!this.isRunning) return;

    logger.info('🛑 Shutting down scan worker...');
    this.isRunning = false;

    try {
      // Cancel all active scans
      await scanService.cancelPendingScans();

      // Stop all scheduled tasks
      for (const task of this.scheduledTasks.values()) {
        task.stop();
      }

      // Close database connection
      await database.close();

      logger.info('✅ Scan worker shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during worker shutdown:', error);
      process.exit(1);
    }
  }

  // Get worker status
  getStatus() {
    return {
      isRunning: this.isRunning,
      database: database.getStatus(),
      queue: {
        active: scanService.activeJobs.size,
        queued: scanService.jobQueue.length,
        processing: scanService.isProcessing
      },
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
  }
}

// Start worker if this file is run directly
if (require.main === module) {
  const worker = new ScanWorker();
  worker.initialize().catch(error => {
    console.error('❌ Failed to start scan worker:', error);
    process.exit(1);
  });
}

module.exports = ScanWorker;