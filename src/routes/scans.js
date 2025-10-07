const express = require('express');
const router = express.Router();
const ScanJob = require('../models/ScanJob');
const ScanResult = require('../models/ScanResult');
const scanService = require('../services/scanService');

// GET /api/scans - Get all scan jobs with filtering
router.get('/', async (req, res) => {
  try {
    const filter = {};
    const options = {
      sort: { created_at: -1 },
      limit: parseInt(req.query.limit) || 50,
      populate: {
        path: 'project_id',
        select: 'name repo_url owner'
      }
    };

    // Apply filters
    if (req.query.status) {
      filter.status = req.query.status;
    }
    
    if (req.query.project_id) {
      filter.project_id = req.query.project_id;
    }
    
    if (req.query.trigger_source) {
      filter.trigger_source = req.query.trigger_source;
    }
    
    if (req.query.branch) {
      filter.branch = req.query.branch;
    }

    // Date range filter
    if (req.query.date_from || req.query.date_to) {
      filter.created_at = {};
      if (req.query.date_from) {
        filter.created_at.$gte = new Date(req.query.date_from);
      }
      if (req.query.date_to) {
        filter.created_at.$lte = new Date(req.query.date_to);
      }
    }

    const scans = await ScanJob.find(filter, null, options);
    
    res.json({
      success: true,
      count: scans.length,
      data: scans.map(scan => ({
        ...scan.toObject(),
        duration_ms: scan.duration_ms,
        is_active: scan.is_active
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/pending - Get pending scan jobs
router.get('/pending', async (req, res) => {
  try {
    const pendingJobs = await ScanJob.findPendingJobs(parseInt(req.query.limit) || 10);
    
    res.json({
      success: true,
      count: pendingJobs.length,
      data: pendingJobs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/recent - Get recent scan jobs
router.get('/recent', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const recentJobs = await ScanJob.findRecentJobs(hours);
    
    res.json({
      success: true,
      count: recentJobs.length,
      data: recentJobs,
      timeframe: `${hours} hours`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/:id - Get specific scan job
router.get('/:id', async (req, res) => {
  try {
    const scan = await ScanJob.findById(req.params.id)
      .populate('project_id', 'name repo_url owner github_config');
    
    if (!scan) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    // Get results count
    const resultsCount = await ScanResult.countDocuments({ job_id: req.params.id });
    
    res.json({
      success: true,
      data: {
        ...scan.toObject(),
        results_count: resultsCount,
        duration_ms: scan.duration_ms,
        is_active: scan.is_active,
        github_context: scan.getGitHubContext()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/:id/results - Get scan results
router.get('/:id/results', async (req, res) => {
  try {
    const options = {
      severity: req.query.severity,
      category: req.query.category,
      status: req.query.status
    };

    // Remove undefined values
    Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);

    const results = await ScanResult.findByJob(req.params.id, options)
      .limit(parseInt(req.query.limit) || 100);
    
    // Get statistics
    const stats = await ScanResult.getStatsByJob(req.params.id);
    
    res.json({
      success: true,
      count: results.length,
      data: results.map(result => ({
        ...result.toObject(),
        line_range: result.line_range,
        severity_score: result.severity_score,
        risk_score: result.risk_score,
        is_security_issue: result.is_security_issue
      })),
      statistics: stats[0] || null,
      filters: options
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/:id/results/:result_id - Get specific scan result
router.get('/:id/results/:result_id', async (req, res) => {
  try {
    const result = await ScanResult.findOne({
      _id: req.params.result_id,
      job_id: req.params.id
    });
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Scan result not found'
      });
    }

    // Get context with surrounding code lines
    const context = result.getContext(parseInt(req.query.context_lines) || 3);
    
    res.json({
      success: true,
      data: {
        ...result.toObject(),
        context: context,
        line_range: result.line_range,
        severity_score: result.severity_score,
        risk_score: result.risk_score,
        is_security_issue: result.is_security_issue
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/scans/:id/results/:result_id/triage - Triage scan result
router.put('/:id/results/:result_id/triage', async (req, res) => {
  try {
    const { status, reason, notes } = req.body;
    
    if (!status || !['open', 'false_positive', 'fixed', 'ignored', 'wont_fix'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Valid triage status is required'
      });
    }

    const result = await ScanResult.findOne({
      _id: req.params.result_id,
      job_id: req.params.id
    });
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Scan result not found'
      });
    }

    const triaged_by = req.headers['x-user-id'] || 'api';
    await result.updateTriage(status, reason || '', triaged_by, notes || '');
    
    res.json({
      success: true,
      message: 'Result triaged successfully',
      data: result
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/scans/:id/rerun - Rerun scan job
router.post('/:id/rerun', async (req, res) => {
  try {
    const originalScan = await ScanJob.findById(req.params.id).populate('project_id');
    
    if (!originalScan) {
      return res.status(404).json({
        success: false,
        error: 'Original scan job not found'
      });
    }

    if (!originalScan.canBeRetried()) {
      return res.status(400).json({
        success: false,
        error: 'Scan cannot be rerun (too old or invalid status)'
      });
    }

    // Create new scan job with same configuration
    const triggerData = {
      source: 'manual',
      event: 'rerun',
      priority: req.body.priority || originalScan.priority,
      branch: req.body.branch || originalScan.branch,
      commit_sha: req.body.commit_sha || originalScan.commit_sha,
      metadata: {
        rerun_of: originalScan._id.toString(),
        triggered_by: req.headers['x-user-id'] || 'api',
        trigger_reason: 'Scan rerun requested'
      }
    };

    const newScan = await scanService.createScanJob(originalScan.project_id._id, triggerData);
    
    res.status(201).json({
      success: true,
      message: 'Scan rerun created and queued',
      data: newScan
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/scans/:id/cancel - Cancel running scan
router.put('/:id/cancel', async (req, res) => {
  try {
    const cancelledScan = await scanService.cancelScan(req.params.id);
    
    res.json({
      success: true,
      message: 'Scan cancelled successfully',
      data: cancelledScan
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/:id/logs - Get scan logs
router.get('/:id/logs', async (req, res) => {
  try {
    const scan = await ScanJob.findById(req.params.id);
    
    if (!scan) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    const level = req.query.level;
    let logs = scan.log || [];
    
    // Filter by log level if specified
    if (level) {
      logs = logs.filter(logEntry => logEntry.level === level);
    }

    // Sort by timestamp (newest first)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Limit results
    const limit = parseInt(req.query.limit) || 100;
    logs = logs.slice(0, limit);

    res.json({
      success: true,
      count: logs.length,
      data: logs,
      filters: { level }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/stats/overview - Get scan statistics overview
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await ScanJob.getStatistics();
    
    // Get additional metrics
    const totalJobs = await ScanJob.countDocuments();
    const activeJobs = await ScanJob.countDocuments({ 
      status: { $in: ['pending', 'queued', 'running'] } 
    });
    
    // Get recent activity (last 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentActivity = await ScanJob.countDocuments({
      created_at: { $gte: weekAgo }
    });

    // Calculate success rate
    const completedJobs = await ScanJob.countDocuments({ status: 'completed' });
    const failedJobs = await ScanJob.countDocuments({ status: 'failed' });
    const successRate = totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0;

    res.json({
      success: true,
      data: {
        total_jobs: totalJobs,
        active_jobs: activeJobs,
        recent_activity: recentActivity,
        success_rate: successRate,
        by_status: stats,
        completed_jobs: completedJobs,
        failed_jobs: failedJobs
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/scans/bulk-cancel - Cancel multiple scans
router.post('/bulk-cancel', async (req, res) => {
  try {
    const { scan_ids } = req.body;
    
    if (!scan_ids || !Array.isArray(scan_ids) || scan_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'scan_ids array is required'
      });
    }

    const results = [];
    const errors = [];

    for (const scanId of scan_ids) {
      try {
        const cancelledScan = await scanService.cancelScan(scanId);
        results.push(cancelledScan);
      } catch (error) {
        errors.push({ scan_id: scanId, error: error.message });
      }
    }

    res.json({
      success: true,
      message: `Bulk cancel completed: ${results.length} successful, ${errors.length} failed`,
      data: {
        cancelled: results,
        errors: errors
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/scans/:id/export - Export scan results
router.get('/:id/export', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    
    const scan = await ScanJob.findById(req.params.id).populate('project_id', 'name repo_url');
    if (!scan) {
      return res.status(404).json({
        success: false,
        error: 'Scan job not found'
      });
    }

    const results = await ScanResult.findByJob(req.params.id);
    
    const exportData = {
      scan_info: {
        id: scan._id,
        project_name: scan.project_id.name,
        repo_url: scan.project_id.repo_url,
        branch: scan.branch,
        commit_sha: scan.commit_sha,
        created_at: scan.created_at,
        status: scan.status,
        summary: scan.summary
      },
      results: results.map(result => ({
        rule_id: result.rule_id,
        file_path: result.file_path,
        line_start: result.line_start,
        line_end: result.line_end,
        severity: result.severity,
        category: result.category,
        message: result.message,
        code_snippet: result.code_snippet,
        status: result.status,
        metadata: result.metadata
      }))
    };

    if (format === 'csv') {
      // Simple CSV conversion without external library
      const fields = ['rule_id', 'file_path', 'line_start', 'severity', 'category', 'message', 'status'];
      
      // Create CSV header
      let csvData = fields.join(',') + '\n';
      
      // Create CSV rows
      exportData.results.forEach(result => {
        const row = fields.map(field => {
          let value = result[field] || '';
          // Escape quotes and wrap in quotes if contains comma
          value = String(value).replace(/"/g, '""');
          if (String(value).includes(',')) {
            value = `"${value}"`;
          }
          return value;
        });
        csvData += row.join(',') + '\n';
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="scan-${scan._id}-results.csv"`);
      res.send(csvData);
    } else {
      // Default to JSON
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="scan-${scan._id}-results.json"`);
      res.json(exportData);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;