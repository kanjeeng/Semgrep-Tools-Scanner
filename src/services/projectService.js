const Project = require('../models/Project');
const ScanJob = require('../models/ScanJob');
const ScanResult = require('../models/ScanResult');
const githubService = require('./githubService');

class ProjectService {
  constructor() {
    // Cache for project statistics to avoid frequent DB queries
    this.statsCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  // Create a new project
  async createProject(projectData) {
    try {
      // Validate GitHub repository access
      if (process.env.GITHUB_TOKEN) {
        const repoInfo = await githubService.validateRepository(projectData.repo_url);
        projectData.github_config = {
          ...projectData.github_config,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          default_branch: repoInfo.default_branch,
          is_private: repoInfo.private,
          has_issues: repoInfo.has_issues,
          has_projects: repoInfo.has_projects,
          has_wiki: repoInfo.has_wiki
        };
      }

      const project = new Project(projectData);
      await project.save();

      // Setup webhook if auto_scan is enabled
      if (project.auto_scan && process.env.GITHUB_TOKEN) {
        try {
          await githubService.createWebhook(project);
          console.log(`✅ Webhook created for project: ${project.name}`);
        } catch (webhookError) {
          console.warn(`⚠️ Failed to create webhook for ${project.name}: ${webhookError.message}`);
        }
      }

      // Clear cache
      this.statsCache.delete('overview');

      return project;
    } catch (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }
  }

  // Get project by ID with detailed information
  async getProject(projectId) {
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      // Get recent scan activity
      const recentScans = await ScanJob.find({ project_id: projectId })
        .sort({ created_at: -1 })
        .limit(5)
        .select('status created_at finished_at summary');

      // Get findings statistics
      const findingsStats = await this.getProjectFindingsStats(projectId);

      return {
        ...project.toObject(),
        recent_activity: recentScans,
        findings_stats: findingsStats
      };
    } catch (error) {
      throw new Error(`Failed to get project: ${error.message}`);
    }
  }

  // Update project
  async updateProject(projectId, updateData) {
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const oldAutoScan = project.auto_scan;

      // Update fields
      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined && key !== '_id') {
          project[key] = updateData[key];
        }
      });

      await project.save();

      // Handle webhook changes
      if (process.env.GITHUB_TOKEN) {
        if (oldAutoScan !== project.auto_scan) {
          if (project.auto_scan) {
            try {
              await githubService.createWebhook(project);
              console.log(`✅ Webhook created for project: ${project.name}`);
            } catch (webhookError) {
              console.warn(`⚠️ Failed to create webhook: ${webhookError.message}`);
            }
          } else {
            try {
              await githubService.deleteWebhook(project);
              console.log(`✅ Webhook removed for project: ${project.name}`);
            } catch (webhookError) {
              console.warn(`⚠️ Failed to remove webhook: ${webhookError.message}`);
            }
          }
        }
      }

      // Clear cache
      this.statsCache.delete('overview');
      this.statsCache.delete(projectId);

      return project;
    } catch (error) {
      throw new Error(`Failed to update project: ${error.message}`);
    }
  }

  // Delete project
  async deleteProject(projectId) {
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      // Delete webhook if exists
      if (process.env.GITHUB_TOKEN && project.github_config.webhook_id) {
        try {
          await githubService.deleteWebhook(project);
        } catch (webhookError) {
          console.warn(`⚠️ Failed to delete webhook: ${webhookError.message}`);
        }
      }

      // Delete related scan jobs and results
      await ScanJob.deleteMany({ project_id: projectId });
      await ScanResult.deleteMany({ 
        job_id: { 
          $in: (await ScanJob.find({ project_id: projectId }).select('_id')).map(job => job._id) 
        } 
      });

      await Project.findByIdAndDelete(projectId);

      // Clear cache
      this.statsCache.delete('overview');
      this.statsCache.delete(projectId);

      return true;
    } catch (error) {
      throw new Error(`Failed to delete project: ${error.message}`);
    }
  }

  // Get project statistics
  async getProjectStats(projectId) {
    try {
      // Check cache first
      const cacheKey = `project-${projectId}`;
      const cached = this.statsCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      // Calculate additional statistics
      const scanStats = await ScanJob.aggregate([
        { $match: { project_id: project._id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            avg_duration: { $avg: '$scan_time_ms' }
          }
        }
      ]);

      const recentFindings = await ScanResult.aggregate([
        {
          $lookup: {
            from: 'scanjobs',
            localField: 'job_id',
            foreignField: '_id',
            as: 'job'
          }
        },
        { $match: { 'job.project_id': project._id } },
        {
          $group: {
            _id: '$severity',
            count: { $sum: 1 }
          }
        }
      ]);

      const stats = {
        project: project.statistics,
        scans: scanStats,
        recent_findings: recentFindings,
        health_score: project.scan_health_score
      };

      // Update cache
      this.statsCache.set(cacheKey, {
        timestamp: Date.now(),
        data: stats
      });

      return stats;
    } catch (error) {
      throw new Error(`Failed to get project stats: ${error.message}`);
    }
  }

  // Get findings statistics for a project
  async getProjectFindingsStats(projectId) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const stats = await ScanResult.aggregate([
        {
          $lookup: {
            from: 'scanjobs',
            localField: 'job_id',
            foreignField: '_id',
            as: 'job'
          }
        },
        { $match: { 'job.project_id': new require('mongoose').Types.ObjectId(projectId) } },
        {
          $facet: {
            by_severity: [
              {
                $group: {
                  _id: '$severity',
                  count: { $sum: 1 }
                }
              }
            ],
            by_category: [
              {
                $group: {
                  _id: '$category',
                  count: { $sum: 1 }
                }
              }
            ],
            by_status: [
              {
                $group: {
                  _id: '$status',
                  count: { $sum: 1 }
                }
              }
            ],
            recent_trend: [
              { $match: { created_at: { $gte: thirtyDaysAgo } } },
              {
                $group: {
                  _id: {
                    date: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
                    severity: '$severity'
                  },
                  count: { $sum: 1 }
                }
              }
            ]
          }
        }
      ]);

      return stats[0];
    } catch (error) {
      throw new Error(`Failed to get findings stats: ${error.message}`);
    }
  }

  // Get overview statistics for all projects
  async getOverviewStats() {
    try {
      // Check cache first
      const cacheKey = 'overview';
      const cached = this.statsCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const projectCounts = await Project.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      const scanStats = await ScanJob.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      const findingsStats = await ScanResult.aggregate([
        {
          $group: {
            _id: '$severity',
            count: { $sum: 1 }
          }
        }
      ]);

      const recentActivity = await ScanJob.find()
        .sort({ created_at: -1 })
        .limit(10)
        .populate('project_id', 'name')
        .select('project_id status created_at finished_at');

      const stats = {
        projects: projectCounts,
        scans: scanStats,
        findings: findingsStats,
        recent_activity: recentActivity
      };

      // Update cache
      this.statsCache.set(cacheKey, {
        timestamp: Date.now(),
        data: stats
      });

      return stats;
    } catch (error) {
      throw new Error(`Failed to get overview stats: ${error.message}`);
    }
  }

  // Get projects that need scanning (for scheduled scans)
  async getProjectsForScheduledScan() {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const projects = await Project.find({
        status: 'active',
        auto_scan: true,
        $or: [
          { 'statistics.last_scan_at': { $lt: twentyFourHoursAgo } },
          { 'statistics.last_scan_at': { $exists: false } }
        ]
      });

      return projects;
    } catch (error) {
      throw new Error(`Failed to get projects for scheduled scan: ${error.message}`);
    }
  }

  // Validate project configuration
  async validateProjectConfig(projectId) {
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const issues = [];

      // Check GitHub access
      if (process.env.GITHUB_TOKEN) {
        try {
          await githubService.validateRepository(project.repo_url);
        } catch (error) {
          issues.push(`GitHub repository access failed: ${error.message}`);
        }
      }

      // Check rules configuration
      const activeRules = await project.getActiveScanRules();
      if (activeRules.length === 0) {
        issues.push('No active rules configured for this project');
      }

      // Check scan configuration
      if (project.scan_config.timeout_seconds > 1800) {
        issues.push('Scan timeout exceeds maximum recommended value (1800 seconds)');
      }

      return {
        valid: issues.length === 0,
        issues: issues,
        project: {
          id: project._id,
          name: project.name,
          repo_url: project.repo_url,
          active_rules: activeRules.length,
          auto_scan: project.auto_scan
        }
      };
    } catch (error) {
      throw new Error(`Failed to validate project config: ${error.message}`);
    }
  }

  // Clear cache (useful for testing)
  clearCache() {
    this.statsCache.clear();
  }
}

module.exports = new ProjectService();