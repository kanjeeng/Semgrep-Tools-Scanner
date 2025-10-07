const mongoose = require('mongoose');

const scanJobSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  trigger_source: {
    type: String,
    required: true,
    enum: ['manual', 'webhook', 'scheduled', 'api'],
    default: 'manual'
  },
  trigger_event: {
    type: String,
    required: true,
    maxlength: 100
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  priority: {
    type: Number,
    default: 5,
    min: 1,
    max: 10
  },
  branch: {
    type: String,
    required: true,
    trim: true
  },
  commit_sha: {
    type: String,
    trim: true,
    match: /^[a-f0-9]{7,40}$/
  },
  commit_message: {
    type: String,
    maxlength: 1000
  },
  pr_number: {
    type: Number,
    min: 1
  },
  pr_title: {
    type: String,
    maxlength: 500
  },
  pr_author: {
    type: String,
    trim: true
  },
  ruleset: [{
    type: String,
    ref: 'SemgrepRule'
  }],
  scan_config: {
    include_paths: [String],
    exclude_paths: [String],
    max_file_size_kb: {
      type: Number,
      default: 1024
    },
    timeout_seconds: {
      type: Number,
      default: 300
    }
  },
  repository_info: {
    clone_url: String,
    total_files: Number,
    languages: [String],
    size_kb: Number
  },
  summary: {
    total_findings: {
      type: Number,
      default: 0
    },
    files_scanned: {
      type: Number,
      default: 0
    },
    severity_count: {
      ERROR: { type: Number, default: 0 },
      WARNING: { type: Number, default: 0 },
      INFO: { type: Number, default: 0 }
    },
    categories: {
      security: { type: Number, default: 0 },
      performance: { type: Number, default: 0 },
      correctness: { type: Number, default: 0 },
      style: { type: Number, default: 0 },
      maintainability: { type: Number, default: 0 },
      'best-practices': { type: Number, default: 0 },
      dependencies: { type: Number, default: 0 }
    }
  },
  scan_time_ms: {
    type: Number,
    default: 0
  },
  started_at: Date,
  finished_at: Date,
  log: [{
    level: {
      type: String,
      enum: ['debug', 'info', 'warn', 'error'],
      required: true
    },
    message: {
      type: String,
      required: true,
      maxlength: 1000
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    metadata: mongoose.Schema.Types.Mixed
  }],
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: { 
    createdAt: 'created_at', 
    updatedAt: 'updated_at' 
  }
});

// Indexes for performance
scanJobSchema.index({ project_id: 1, status: 1 });
scanJobSchema.index({ status: 1, priority: -1 });
scanJobSchema.index({ 'metadata.pr_number': 1 });
scanJobSchema.index({ created_at: -1 });

// Virtual fields
scanJobSchema.virtual('duration_ms').get(function() {
  if (this.started_at && this.finished_at) {
    return this.finished_at.getTime() - this.started_at.getTime();
  }
  if (this.started_at) {
    return Date.now() - this.started_at.getTime();
  }
  return 0;
});

scanJobSchema.virtual('is_active').get(function() {
  return ['pending', 'queued', 'running'].includes(this.status);
});

// Instance methods
scanJobSchema.methods.addLog = function(level, message, metadata = {}) {
  this.log.push({
    level,
    message,
    timestamp: new Date(),
    metadata
  });
  
  // Keep only last 1000 log entries
  if (this.log.length > 1000) {
    this.log = this.log.slice(-1000);
  }
  
  return this.save();
};

scanJobSchema.methods.updateStatus = async function(newStatus, error = null) {
  this.status = newStatus;
  
  if (newStatus === 'running' && !this.started_at) {
    this.started_at = new Date();
  } else if (['completed', 'failed', 'cancelled'].includes(newStatus) && !this.finished_at) {
    this.finished_at = new Date();
    this.scan_time_ms = this.duration_ms;
  }
  
  if (error) {
    this.addLog('error', `Status changed to ${newStatus}: ${error.message}`, {
      error: error.message,
      stack: error.stack
    });
  } else {
    this.addLog('info', `Status changed to ${newStatus}`);
  }
  
  return this.save();
};

scanJobSchema.methods.updateSummary = function(scanResults = []) {
  this.summary.total_findings = scanResults.length;
  
  // Count by severity and category
  const severityCount = { ERROR: 0, WARNING: 0, INFO: 0 };
  const categoryCount = {
    security: 0, performance: 0, correctness: 0, style: 0,
    maintainability: 0, 'best-practices': 0, dependencies: 0
  };
  
  scanResults.forEach(result => {
    severityCount[result.severity] = (severityCount[result.severity] || 0) + 1;
    categoryCount[result.category] = (categoryCount[result.category] || 0) + 1;
  });
  
  this.summary.severity_count = severityCount;
  this.summary.categories = categoryCount;
  
  return this.save();
};

scanJobSchema.methods.canBeRetried = function() {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const isRecent = Date.now() - this.created_at.getTime() < maxAge;
  return isRecent && ['completed', 'failed', 'cancelled'].includes(this.status);
};

scanJobSchema.methods.getGitHubContext = function() {
  if (!this.pr_number) return null;
  
  return {
    pr_number: this.pr_number,
    pr_title: this.pr_title,
    pr_author: this.pr_author,
    branch: this.branch,
    commit_sha: this.commit_sha
  };
};

// Static methods
scanJobSchema.statics.findPendingJobs = function(limit = 10) {
  return this.find({
    status: { $in: ['pending', 'queued'] }
  })
  .sort({ priority: -1, created_at: 1 })
  .limit(limit)
  .populate('project_id', 'name repo_url');
};

scanJobSchema.statics.findRecentJobs = function(hours = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  return this.find({
    created_at: { $gte: cutoff }
  })
  .sort({ created_at: -1 })
  .populate('project_id', 'name repo_url');
};

scanJobSchema.statics.findByProject = function(projectId, limit = 20) {
  return this.find({ project_id: projectId })
    .sort({ created_at: -1 })
    .limit(limit);
};

scanJobSchema.statics.getStatistics = function(filter = {}) {
  const matchStage = {};
  
  if (filter.project_id) {
    matchStage.project_id = new mongoose.Types.ObjectId(filter.project_id);
  }
  
  if (filter.date_from || filter.date_to) {
    matchStage.created_at = {};
    if (filter.date_from) {
      matchStage.created_at.$gte = new Date(filter.date_from);
    }
    if (filter.date_to) {
      matchStage.created_at.$lte = new Date(filter.date_to);
    }
  }
  
  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avg_duration: { $avg: '$scan_time_ms' },
        total_findings: { $sum: '$summary.total_findings' }
      }
    }
  ]);
};

// Pre-save middleware
scanJobSchema.pre('save', function(next) {
  // Ensure branch has a value
  if (!this.branch) {
    this.branch = 'main';
  }
  
  // Validate scan configuration
  if (this.scan_config.timeout_seconds > 1800) {
    return next(new Error('Scan timeout cannot exceed 1800 seconds (30 minutes)'));
  }
  
  next();
});

module.exports = mongoose.model('ScanJob', scanJobSchema);