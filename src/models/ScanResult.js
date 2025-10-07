const mongoose = require('mongoose');

const scanResultSchema = new mongoose.Schema({
  job_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ScanJob',
    required: true,
    index: true
  },
  rule_id: {
    type: String,
    ref: 'SemgrepRule',
    required: true,
    index: true
  },
  file_path: {
    type: String,
    required: true,
    maxlength: 500,
    index: true
  },
  line_start: {
    type: Number,
    required: true,
    min: 1
  },
  line_end: {
    type: Number,
    required: true,
    min: 1
  },
  column_start: {
    type: Number,
    min: 1
  },
  column_end: {
    type: Number,
    min: 1
  },
  severity: {
    type: String,
    required: true,
    enum: ['INFO', 'WARNING', 'ERROR'],
    index: true
  },
  category: {
    type: String,
    required: true,
    enum: [
      'security', 'performance', 'correctness', 'style', 
      'maintainability', 'best-practices', 'dependencies'
    ],
    index: true
  },
  message: {
    type: String,
    required: true,
    maxlength: 1000
  },
  code_snippet: {
    type: String,
    maxlength: 2000
  },
  fix_suggestion: {
    type: String,
    maxlength: 1000
  },
  metadata: {
    cwe: String,
    owasp: String,
    confidence: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH'],
      default: 'MEDIUM'
    },
    likelihood: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH'],
      default: 'MEDIUM'
    },
    impact: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH'],
      default: 'MEDIUM'
    },
    references: [String],
    tags: [String]
  },
  semgrep_output: {
    check_id: String,
    start: {
      line: Number,
      col: Number,
      offset: Number
    },
    end: {
      line: Number,
      col: Number,
      offset: Number
    },
    extra: mongoose.Schema.Types.Mixed,
    path: String
  },
  status: {
    type: String,
    enum: ['open', 'false_positive', 'fixed', 'ignored', 'wont_fix'],
    default: 'open',
    index: true
  },
  triage: {
    status: {
      type: String,
      enum: ['open', 'false_positive', 'fixed', 'ignored', 'wont_fix'],
      default: 'open'
    },
    reason: {
      type: String,
      maxlength: 500
    },
    triaged_by: String,
    triaged_at: Date,
    notes: {
      type: String,
      maxlength: 1000
    }
  },
  git_context: {
    commit_sha: String,
    branch: String,
    author: String,
    commit_date: Date,
    diff_hunk: String
  },
  duplicate_of: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ScanResult'
  },
  fingerprint: {
    type: String,
    index: true,
    unique: false
  }
}, {
  timestamps: { 
    createdAt: 'created_at', 
    updatedAt: 'updated_at' 
  }
});

// Compound indexes
scanResultSchema.index({ job_id: 1, severity: 1 });
scanResultSchema.index({ job_id: 1, category: 1 });
scanResultSchema.index({ job_id: 1, status: 1 });
scanResultSchema.index({ file_path: 1, line_start: 1 });
scanResultSchema.index({ rule_id: 1, status: 1 });
scanResultSchema.index({ fingerprint: 1, status: 1 });

// Virtual fields
scanResultSchema.virtual('line_range').get(function() {
  if (this.line_start === this.line_end) {
    return `line ${this.line_start}`;
  }
  return `lines ${this.line_start}-${this.line_end}`;
});

scanResultSchema.virtual('severity_score').get(function() {
  const scores = { ERROR: 3, WARNING: 2, INFO: 1 };
  return scores[this.severity] || 0;
});

scanResultSchema.virtual('risk_score').get(function() {
  const severityWeight = { ERROR: 30, WARNING: 20, INFO: 10 };
  const confidenceWeight = { HIGH: 1.0, MEDIUM: 0.7, LOW: 0.4 };
  const impactWeight = { HIGH: 1.0, MEDIUM: 0.7, LOW: 0.4 };
  
  const baseScore = severityWeight[this.severity] || 10;
  const confidence = confidenceWeight[this.metadata?.confidence] || 0.7;
  const impact = impactWeight[this.metadata?.impact] || 0.7;
  
  return Math.round(baseScore * confidence * impact);
});

scanResultSchema.virtual('is_security_issue').get(function() {
  return this.category === 'security' || 
         (this.metadata?.cwe && this.metadata.cwe.length > 0) ||
         (this.metadata?.owasp && this.metadata.owasp.length > 0);
});

// Instance methods
scanResultSchema.methods.generateFingerprint = function() {
  const crypto = require('crypto');
  const fingerprintData = [
    this.rule_id,
    this.file_path,
    this.line_start,
    this.line_end,
    this.message.replace(/\s+/g, ' ').trim()
  ].join('|');
  
  this.fingerprint = crypto.createHash('md5').update(fingerprintData).digest('hex');
  return this.fingerprint;
};

scanResultSchema.methods.updateTriage = function(status, reason, triaged_by, notes = '') {
  this.triage = {
    status: status,
    reason: reason,
    triaged_by: triaged_by,
    triaged_at: new Date(),
    notes: notes
  };
  this.status = status;
  return this.save();
};

scanResultSchema.methods.markAsDuplicate = function(originalResult) {
  this.duplicate_of = originalResult._id;
  this.status = 'ignored';
  this.triage = {
    status: 'ignored',
    reason: 'duplicate',
    triaged_by: 'system',
    triaged_at: new Date(),
    notes: `Duplicate of finding ${originalResult._id}`
  };
  return this.save();
};

scanResultSchema.methods.getContext = function(contextLines = 3) {
  if (!this.code_snippet) return null;
  
  const lines = this.code_snippet.split('\n');
  const targetLine = this.line_start;
  const startLine = Math.max(1, targetLine - contextLines);
  const endLine = Math.min(lines.length, targetLine + contextLines);
  
  return {
    start_line: startLine,
    end_line: endLine,
    highlighted_line: targetLine,
    code: lines.slice(startLine - 1, endLine).join('\n')
  };
};

// Static methods
scanResultSchema.statics.findByJob = function(jobId, options = {}) {
  const query = this.find({ job_id: jobId });
  
  if (options.severity) {
    query.where({ severity: options.severity });
  }
  
  if (options.category) {
    query.where({ category: options.category });
  }
  
  if (options.status) {
    query.where({ status: options.status });
  }
  
  return query.sort({ severity: -1, line_start: 1 });
};

scanResultSchema.statics.findDuplicates = function(result) {
  return this.find({
    _id: { $ne: result._id },
    rule_id: result.rule_id,
    file_path: result.file_path,
    line_start: result.line_start,
    line_end: result.line_end,
    status: { $ne: 'ignored' }
  });
};

scanResultSchema.statics.getStatsByJob = function(jobId) {
  return this.aggregate([
    { $match: { job_id: new mongoose.Types.ObjectId(jobId) } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        by_severity: {
          $push: {
            severity: '$severity',
            count: 1
          }
        },
        by_category: {
          $push: {
            category: '$category',
            count: 1
          }
        },
        by_status: {
          $push: {
            status: '$status',
            count: 1
          }
        }
      }
    }
  ]);
};

scanResultSchema.statics.getTopFindings = function(filter = {}, limit = 10) {
  return this.aggregate([
    { $match: filter },
    {
      $group: {
        _id: {
          rule_id: '$rule_id',
          message: '$message'
        },
        count: { $sum: 1 },
        severity: { $first: '$severity' },
        category: { $first: '$category' }
      }
    },
    { $sort: { count: -1, severity: -1 } },
    { $limit: limit }
  ]);
};

scanResultSchema.statics.findByFingerprint = function(fingerprint) {
  return this.find({ 
    fingerprint: fingerprint,
    status: { $ne: 'ignored' }
  }).sort({ created_at: -1 });
};

// Pre-save middleware
scanResultSchema.pre('save', function(next) {
  if (!this.fingerprint) {
    this.generateFingerprint();
  }
  
  if (this.line_end < this.line_start) {
    this.line_end = this.line_start;
  }
  
  if (this.column_start && this.column_end && this.column_end < this.column_start) {
    this.column_end = this.column_start;
  }
  
  next();
});

module.exports = mongoose.model('ScanResult', scanResultSchema);