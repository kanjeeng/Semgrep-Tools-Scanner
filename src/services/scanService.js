const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');
const { v4: uuidv4 } = require('uuid');

const Project = require('../models/Project');
const ScanJob = require('../models/ScanJob');
const ScanResult = require('../models/ScanResult');
const SemgrepRule = require('../models/Rule');
const semgrepConfig = require('../config/semgrep');

class ScanService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || path.join(__dirname, '../../temp');
    this.maxConcurrentJobs = parseInt(process.env.WORKER_CONCURRENT_JOBS) || 3;
    this.semgrepTimeout = parseInt(process.env.SEMGREP_TIMEOUT) || 300;
    this.activeJobs = new Map();
    this.jobQueue = [];
    this.isProcessing = false;
  }

  async initialize() {
    // Ensure temp directory exists
    await fs.ensureDir(this.tempDir);
    
    // Clean up any orphaned temp directories
    await this.cleanupTempDirectories();
    
    // Start processing queue
    this.startQueueProcessor();
    
    console.log('🔄 Scan service initialized');
  }

  // Create a new scan job
  async createScanJob(projectId, triggerData = {}) {
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      // Get active rules for this project
      const rules = await project.getActiveScanRules();
      if (rules.length === 0) {
        throw new Error('No active rules found for project');
      }

      const jobData = {
        project_id: projectId,
        trigger_source: triggerData.source || 'manual',
        trigger_event: triggerData.event || 'manual_trigger',
        status: 'pending',
        priority: triggerData.priority || 5,
        commit_sha: triggerData.commit_sha,
        commit_message: triggerData.commit_message,
        branch: triggerData.branch || project.branch,
        pr_number: triggerData.pr_number,
        pr_title: triggerData.pr_title,
        pr_author: triggerData.pr_author,
        ruleset: rules.map(rule => rule._id),
        scan_config: {
          include_paths: project.scan_config.include_paths || [],
          exclude_paths: project.scan_config.exclude_paths || [],
          max_file_size_kb: project.scan_config.max_file_size_kb || 1024,
          timeout_seconds: project.scan_config.timeout_seconds || this.semgrepTimeout
        },
        metadata: triggerData.metadata || {}
      };

      const job = new ScanJob(jobData);
      await job.save();
      
      await job.addLog('info', 'Scan job created and queued');
      
      // Add to processing queue
      this.addToQueue(job);
      
      return job;
    } catch (error) {
      throw new Error(`Failed to create scan job: ${error.message}`);
    }
  }

  // Execute a scan job
  async executeScan(jobId) {
    let job = null;
    let workingDir = null;
    
    try {
      job = await ScanJob.findById(jobId).populate('project_id');
      if (!job) {
        throw new Error('Scan job not found');
      }

      if (job.status !== 'pending' && job.status !== 'queued') {
        throw new Error(`Job is not in executable state: ${job.status}`);
      }

      // Update job status
      await job.updateStatus('running');
      await job.addLog('info', 'Starting scan execution');

      // Create working directory
      workingDir = path.join(this.tempDir, `scan-${jobId}-${Date.now()}`);
      await fs.ensureDir(workingDir);

      // Clone repository
      await job.addLog('info', 'Cloning repository...');
      const repoPath = await this.cloneRepository(job, workingDir);

      // Prepare semgrep rules
      await job.addLog('info', 'Preparing scan rules...');
      const rulesFile = await this.prepareRules(job, workingDir);

      // Run semgrep scan
      await job.addLog('info', 'Executing semgrep scan...');
      const scanResults = await this.runSemgrep(rulesFile, repoPath, job);

      // Process and save results
      await job.addLog('info', `Processing ${scanResults.length} findings...`);
      await this.processScanResults(job, scanResults);

      // Update job summary and status
      await job.updateSummary(scanResults);
      await job.updateStatus('completed');
      await job.addLog('info', `Scan completed successfully with ${scanResults.length} findings`);

      // Update project statistics
      await job.project_id.updateStatistics(job);

      return job;

    } catch (error) {
      console.error(`Scan execution failed for job ${jobId}:`, error);
      
      if (job) {
        await job.updateStatus('failed', error);
        await job.addLog('error', `Scan failed: ${error.message}`, { 
          error: error.message,
          stack: error.stack 
        });
      }
      
      throw error;
    } finally {
      // Clean up working directory
      if (workingDir && await fs.pathExists(workingDir)) {
        try {
          await fs.remove(workingDir);
        } catch (cleanupError) {
          console.warn(`Failed to cleanup working directory: ${cleanupError.message}`);
        }
      }
      
      // Remove from active jobs
      this.activeJobs.delete(jobId);
    }
  }

  // Clone repository to working directory
  async cloneRepository(job, workingDir) {
    try {
      const project = job.project_id;
      const repoPath = path.join(workingDir, 'repo');
      
      const git = simpleGit();
      
      // Clone with shallow depth for performance
      await git.clone(project.repo_url, repoPath, ['--depth', '1', '--branch', job.branch]);
      
      // If specific commit is requested, fetch and checkout
      if (job.commit_sha) {
        const repoGit = simpleGit(repoPath);
        try {
          await repoGit.fetch(['origin', job.commit_sha]);
          await repoGit.checkout(job.commit_sha);
        } catch (checkoutError) {
          console.warn(`Failed to checkout specific commit ${job.commit_sha}: ${checkoutError.message}`);
        }
      }
      
      // Get repository info
      const repoGit = simpleGit(repoPath);
      const log = await repoGit.log(['-1']);
      const status = await repoGit.status();
      
      job.repository_info = {
        clone_url: project.repo_url,
        total_files: await this.countFiles(repoPath),
        languages: await this.detectLanguages(repoPath)
      };
      
      if (log.latest) {
        job.commit_sha = job.commit_sha || log.latest.hash;
        job.commit_message = job.commit_message || log.latest.message;
      }
      
      await job.save();
      
      return repoPath;
    } catch (error) {
      throw new Error(`Failed to clone repository: ${error.message}`);
    }
  }

  // Prepare semgrep rules file
  async prepareRules(job, workingDir) {
    try {
      const rules = await SemgrepRule.find({
        _id: { $in: job.ruleset },
        enabled: true
      });

      if (rules.length === 0) {
        throw new Error('No enabled rules found for scan');
      }

      // Create rules configuration
      const rulesConfig = {
        rules: rules.map(rule => {
          const ruleConfig = {
            id: rule._id,
            languages: rule.language,
            message: rule.message,
            severity: rule.severity,
            patterns: rule.patterns
          };
          
          if (rule.metadata && Object.keys(rule.metadata).length > 0) {
            ruleConfig.metadata = rule.metadata;
          }
          
          return ruleConfig;
        })
      };

      // Write rules to YAML file
      const yaml = require('yaml');
      const rulesFile = path.join(workingDir, 'scan-rules.yml');
      await fs.writeFile(rulesFile, yaml.stringify(rulesConfig));
      
      return rulesFile;
    } catch (error) {
      throw new Error(`Failed to prepare rules: ${error.message}`);
    }
  }

  // Execute semgrep scan
  async runSemgrep(rulesFile, repoPath, job) {
    return new Promise((resolve, reject) => {
      const scanCommand = semgrepConfig.getScanCommand(rulesFile, repoPath, {
        excludePaths: job.scan_config.exclude_paths,
        includePaths: job.scan_config.include_paths
      });

      const semgrep = spawn(scanCommand.command, scanCommand.args, scanCommand.options);

      let output = '';
      let errorOutput = '';

      semgrep.stdout.on('data', (data) => {
        output += data.toString();
      });

      semgrep.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      semgrep.on('close', (code) => {
        // Semgrep exit codes: 0 = no findings, 1 = findings found, >1 = error
        if (code === 0 || code === 1) {
          try {
            const parsed = JSON.parse(output || '{"results": []}');
            resolve(parsed.results || []);
          } catch (parseError) {
            reject(new Error(`Failed to parse semgrep output: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Semgrep failed with exit code ${code}: ${errorOutput}`));
        }
      });

      semgrep.on('error', (error) => {
        reject(new Error(`Failed to start semgrep: ${error.message}`));
      });

      // Store process reference for potential cancellation
      this.activeJobs.set(job._id.toString(), { process: semgrep, job });
    });
  }

  // Process and save scan results
  async processScanResults(job, semgrepResults) {
    const results = [];
    const duplicateMap = new Map();

    for (const result of semgrepResults) {
      try {
        // Extract rule info
        const ruleId = result.check_id;
        const rule = await SemgrepRule.findById(ruleId);
        
        // Create result document
        const scanResult = new ScanResult({
          job_id: job._id,
          rule_id: ruleId,
          file_path: result.path.replace(job.repository_info?.clone_url || '', '').replace(/^\/+/, ''),
          line_start: result.start?.line || 1,
          line_end: result.end?.line || result.start?.line || 1,
          column_start: result.start?.col,
          column_end: result.end?.col,
          severity: result.extra?.severity || rule?.severity || 'WARNING',
          category: rule?.category || 'correctness',
          message: result.extra?.message || rule?.message || 'Potential issue found',
          code_snippet: result.extra?.lines,
          fix_suggestion: rule?.fix_suggestion,
          metadata: {
            ...(rule?.metadata || {}),
            confidence: result.extra?.metadata?.confidence || 'MEDIUM'
          },
          semgrep_output: {
            check_id: result.check_id,
            start: result.start,
            end: result.end,
            extra: result.extra,
            path: result.path
          },
          git_context: {
            commit_sha: job.commit_sha,
            branch: job.branch
          }
        });

        // Generate fingerprint for duplicate detection
        scanResult.generateFingerprint();
        
        // Check for duplicates
        const fingerprint = scanResult.fingerprint;
        if (duplicateMap.has(fingerprint)) {
          // Mark as duplicate
          const originalResult = duplicateMap.get(fingerprint);
          await scanResult.markAsDuplicate(originalResult);
        } else {
          duplicateMap.set(fingerprint, scanResult);
        }

        await scanResult.save();
        results.push(scanResult);
        
      } catch (resultError) {
        console.warn(`Failed to process scan result: ${resultError.message}`, result);
      }
    }

    return results;
  }

  // Cancel a running scan
  async cancelScan(jobId) {
    try {
      const job = await ScanJob.findById(jobId);
      if (!job) {
        throw new Error('Scan job not found');
      }

      if (!['pending', 'queued', 'running'].includes(job.status)) {
        throw new Error(`Cannot cancel job in ${job.status} state`);
      }

      // Kill process if running
      const activeJob = this.activeJobs.get(jobId);
      if (activeJob && activeJob.process) {
        activeJob.process.kill('SIGTERM');
      }

      // Update job status
      await job.updateStatus('cancelled');
      await job.addLog('info', 'Scan cancelled by user request');

      return job;
    } catch (error) {
      throw new Error(`Failed to cancel scan: ${error.message}`);
    }
  }

  // Get scan status
  async getScanStatus(jobId) {
    try {
      const job = await ScanJob.findById(jobId).populate('project_id', 'name repo_url');
      if (!job) {
        throw new Error('Scan job not found');
      }

      const resultsCount = await ScanResult.countDocuments({ job_id: jobId });
      
      return {
        ...job.toObject(),
        results_count: resultsCount,
        is_active: this.activeJobs.has(jobId)
      };
    } catch (error) {
      throw new Error(`Failed to get scan status: ${error.message}`);
    }
  }

  // Queue management
  addToQueue(job) {
    this.jobQueue.push(job._id.toString());
    this.processQueue();
  }

  async processQueue() {
    if (this.isProcessing || this.activeJobs.size >= this.maxConcurrentJobs) {
      return;
    }

    if (this.jobQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const jobId = this.jobQueue.shift();

    try {
      await this.executeScan(jobId);
    } catch (error) {
      console.error(`Queue processing error for job ${jobId}:`, error);
    } finally {
      this.isProcessing = false;
      // Process next job in queue
      setTimeout(() => this.processQueue(), 1000);
    }
  }

  startQueueProcessor() {
    // Process queue every 5 seconds
    setInterval(() => {
      this.processQueue();
    }, 5000);
  }

  // Utility methods
  async countFiles(dirPath) {
    let count = 0;
    const walk = async (dir) => {
      const items = await fs.readdir(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory() && !item.startsWith('.')) {
          await walk(fullPath);
        } else if (stat.isFile()) {
          count++;
        }
      }
    };
    await walk(dirPath);
    return count;
  }

  async detectLanguages(repoPath) {
    const languages = new Set();
    const extensions = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c',
      '.cs': 'csharp',
      '.php': 'php',
      '.rb': 'ruby',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala'
    };

    const walk = async (dir) => {
      try {
        const items = await fs.readdir(dir);
        for (const item of items) {
          if (item.startsWith('.')) continue;
          
          const fullPath = path.join(dir, item);
          const stat = await fs.stat(fullPath);
          
          if (stat.isDirectory()) {
            await walk(fullPath);
          } else if (stat.isFile()) {
            const ext = path.extname(item).toLowerCase();
            if (extensions[ext]) {
              languages.add(extensions[ext]);
            }
          }
        }
      } catch (error) {
        // Ignore permission errors
      }
    };

    await walk(repoPath);
    return Array.from(languages);
  }

  async cleanupTempDirectories() {
    try {
      const items = await fs.readdir(this.tempDir);
      const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago

      for (const item of items) {
        const itemPath = path.join(this.tempDir, item);
        const stat = await fs.stat(itemPath);
        
        if (stat.isDirectory() && stat.mtime.getTime() < cutoff) {
          try {
            await fs.remove(itemPath);
            console.log(`🧹 Cleaned up old temp directory: ${item}`);
          } catch (removeError) {
            console.warn(`Failed to remove temp directory ${item}: ${removeError.message}`);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to cleanup temp directories: ${error.message}`);
    }
  }

  async cancelPendingScans() {
    try {
      const pendingJobs = await ScanJob.find({ 
        status: { $in: ['pending', 'queued', 'running'] } 
      });

      for (const job of pendingJobs) {
        await this.cancelScan(job._id.toString());
      }

      console.log(`⏹️  Cancelled ${pendingJobs.length} pending scans`);
    } catch (error) {
      console.error(`Failed to cancel pending scans: ${error.message}`);
    }
  }
}

module.exports = new ScanService();