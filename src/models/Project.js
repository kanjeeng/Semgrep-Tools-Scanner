const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  repo_url: {
    type: String,
    required: true,
    trim: true,
    unique: true,
    validate: {
      validator: function(v) {
        return /^https:\/\/github\.com\/[\w\.-]+\/[\w\.-]+(?:\.git)?$/.test(v);
      },
      message: 'Invalid GitHub repository URL format'
    }
  },
  branch: {
    type: String,
    default: 'main',
    trim: true
  },
  languages: [{
    type: String,
    enum: [
      'javascript', 'typescript', 'python', 'java', 'go', 'rust',
      'cpp', 'c', 'csharp', 'php', 'ruby', 'swift', 'kotlin',
      'scala', 'bash', 'yaml', 'json', 'html', 'css'
    ]
  }],
  owner: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    maxlength: 1000
  },
  webhook_secret: {
    type: String,
    default: () => uuidv4()
  },
  auto_scan: {
    type: Boolean,
    default: true
  },
  scan_config: {
    rules: [{
      type: String,
      ref: 'SemgrepRule'
    }],
    exclude_paths: [{
      type: String,
      default: ['node_modules/', 'dist/', 'build/', '*.min.js', '*.bundle.js']
    }],
    include_paths: [{
      type: String
    }],
    max_file_size_kb: {
      type: Number,
      default: 1024,
      min: 1,
      max: 10240
    },
    timeout_seconds: {
      type: Number,
      default: 300,
      min: 30,
      max: 1800
    }
  },
  github_config: {
    owner: String,
    repo: String,
    installation_id: String,
    webhook_id: String,
    default_branch: String,
    is_private: Boolean,
    has_issues: Boolean,
    has_projects: Boolean,
    has_wiki: Boolean
  },
  scan_schedule: {
    enabled: {
      type: Boolean,
      default: false
    },
    cron_expression: {
      type: String,
      default: '0 2 * * *'
    },
    timezone: {
      type: String,
      default: 'UTC'
    }
  },
  statistics: {
    total_scans: {
      type: Number,
      default: 0
    },
    last_scan_at: Date,
    last_scan_status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending'
    },
    avg_scan_time_ms: {
      type: Number,
      default: 0
    },
    total_findings: {
      type: Number,
      default: 0
    },
    findings_by_severity: {
      ERROR: { type: Number, default: 0 },
      WARNING: { type: Number, default: 0 },
      INFO: { type: Number, default: 0 }
    },
    findings_by_category: {
      security: { type: Number, default: 0 },
      performance: { type: Number, default: 0 },
      correctness: { type: Number, default: 0 },
      style: { type: Number, default: 0 },
      maintainability: { type: Number, default: 0 },
      'best-practices': { type: Number, default: 0 },
      dependencies: { type: Number, default: 0 }
    }
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'archived'],
    default: 'active'
  },
  created_by: {
    type: String,
    default: 'system'
  },
  updated_by: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: { 
    createdAt: 'created_at', 
    updatedAt: 'updated_at' 
  }
});

// Indexes
projectSchema.index({ owner: 1 });
projectSchema.index({ repo_url: 1 }, { unique: true });
projectSchema.index({ status: 1, auto_scan: 1 });
projectSchema.index({ 'statistics.last_scan_at': -1 });

// Virtual fields
projectSchema.virtual('github_info').get(function() {
  if (!this.repo_url) return null;
  
  const match = this.repo_url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (match) {
    return {
      owner: match[1],
      repo: match[2],
      full_name: `${match[1]}/${match[2]}`,
      html_url: `https://github.com/${match[1]}/${match[2]}`
    };
  }
  return null;
});

projectSchema.virtual('scan_health_score').get(function() {
  let score = 100;
  
  if (this.statistics.total_findings > 0) {
    const errorCount = this.statistics.findings_by_severity.ERROR || 0;
    const warningCount = this.statistics.findings_by_severity.WARNING || 0;
    
    score -= errorCount * 10;
    score -= warningCount * 3;
  }
  
  if (this.statistics.last_scan_at) {
    const daysSinceLastScan = (Date.now() - this.statistics.last_scan_at.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastScan > 7) {
      score -= Math.min(daysSinceLastScan * 2, 30);
    }
  } else {
    score -= 50;
  }
  
  return Math.max(score, 0);
});

// Instance methods
projectSchema.methods.updateStatistics = async function(scanJob) {
  this.statistics.total_scans += 1;
  this.statistics.last_scan_at = scanJob.finished_at || new Date();
  this.statistics.last_scan_status = scanJob.status;
  
  if (scanJob.scan_time_ms) {
    const currentAvg = this.statistics.avg_scan_time_ms || 0;
    const totalScans = this.statistics.total_scans;
    this.statistics.avg_scan_time_ms = Math.round(
      (currentAvg * (totalScans - 1) + scanJob.scan_time_ms) / totalScans
    );
  }
  
  if (scanJob.summary) {
    this.statistics.total_findings = scanJob.summary.total_findings || 0;
    
    if (scanJob.summary.severity_count) {
      this.statistics.findings_by_severity.ERROR = scanJob.summary.severity_count.ERROR || 0;
      this.statistics.findings_by_severity.WARNING = scanJob.summary.severity_count.WARNING || 0;
      this.statistics.findings_by_severity.INFO = scanJob.summary.severity_count.INFO || 0;
    }
    
    if (scanJob.summary.categories) {
      Object.keys(this.statistics.findings_by_category).forEach(category => {
        this.statistics.findings_by_category[category] = scanJob.summary.categories[category] || 0;
      });
    }
  }
  
  return this.save();
};

projectSchema.methods.getActiveScanRules = async function() {
  const SemgrepRule = mongoose.model('SemgrepRule');
  
  if (this.scan_config.rules && this.scan_config.rules.length > 0) {
    return await SemgrepRule.find({
      _id: { $in: this.scan_config.rules },
      enabled: true
    });
  } else {
    return await SemgrepRule.findByLanguage(this.languages);
  }
};

projectSchema.methods.shouldTriggerScan = function(eventType, branch) {
  if (!this.auto_scan || this.status !== 'active') return false;
  
  const targetBranches = [this.branch, this.github_config.default_branch, 'main', 'master'];
  if (!targetBranches.includes(branch)) return false;
  
  return ['push', 'pull_request'].includes(eventType);
};

// Static methods
projectSchema.statics.findByOwner = function(owner) {
  return this.find({ owner: owner, status: { $ne: 'archived' } })
    .sort({ 'statistics.last_scan_at': -1 });
};

projectSchema.statics.findActiveProjects = function() {
  return this.find({ 
    status: 'active',
    auto_scan: true 
  }).sort({ created_at: -1 });
};

projectSchema.statics.findProjectsNeedingScan = function() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  return this.find({
    status: 'active',
    auto_scan: true,
    $or: [
      { 'statistics.last_scan_at': { $lt: oneDayAgo } },
      { 'statistics.last_scan_at': { $exists: false } }
    ]
  });
};

// Pre-save middleware
projectSchema.pre('save', function(next) {
  if (this.repo_url && this.isModified('repo_url')) {
    const githubInfo = this.github_info;
    if (githubInfo) {
      this.github_config.owner = githubInfo.owner;
      this.github_config.repo = githubInfo.repo;
    }
  }
  
  if (!this.languages || this.languages.length === 0) {
    this.languages = ['javascript', 'typescript', 'python'];
  }
  
  if (!this.scan_config.exclude_paths || this.scan_config.exclude_paths.length === 0) {
    this.scan_config.exclude_paths = [
      'node_modules/', 'dist/', 'build/', 'coverage/',
      '*.min.js', '*.bundle.js', '*.map',
      '.git/', '.github/', '.vscode/', '.idea/'
    ];
  }
  
  next();
});

module.exports = mongoose.model('Project', projectSchema);