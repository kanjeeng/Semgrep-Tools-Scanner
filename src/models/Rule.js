const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  _id: {
    type: String,
    required: true,
    trim: true,
    match: /^[a-z0-9-]+$/
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  language: [{
    type: String,
    required: true,
    enum: [
      'javascript', 'typescript', 'python', 'java', 'go', 'rust',
      'cpp', 'c', 'csharp', 'php', 'ruby', 'swift', 'kotlin',
      'scala', 'bash', 'yaml', 'json', 'html', 'css'
    ]
  }],
  severity: {
    type: String,
    required: true,
    enum: ['INFO', 'WARNING', 'ERROR'],
    default: 'WARNING'
  },
  category: {
    type: String,
    required: true,
    enum: [
      'security', 'performance', 'correctness', 'style',
      'maintainability', 'best-practices', 'dependencies'
    ],
    default: 'correctness'
  },
  patterns: [{
    pattern: String,
    'pattern-either': [String],
    'pattern-regex': String,
    'metavariable-pattern': mongoose.Schema.Types.Mixed,
    'pattern-inside': mongoose.Schema.Types.Mixed,
    'pattern-not': mongoose.Schema.Types.Mixed,
    'pattern-not-inside': mongoose.Schema.Types.Mixed,
    message: String,
    severity: String,
    where: [mongoose.Schema.Types.Mixed]
  }],
  message: {
    type: String,
    required: true,
    maxlength: 500
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
    description: {
      type: String,
      maxlength: 1000
    },
    references: [String],
    tags: [String]
  },
  fix_suggestion: {
    type: String,
    maxlength: 500
  },
  yaml_content: {
    type: String,
    required: true
  },
  source: {
    type: String,
    enum: ['custom', 'semgrep-registry', 'imported'],
    default: 'custom'
  },
  enabled: {
    type: Boolean,
    default: true,
    index: true
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

// Indexes for performance
ruleSchema.index({ category: 1, severity: 1 });
ruleSchema.index({ language: 1 });
ruleSchema.index({ enabled: 1, category: 1 });
ruleSchema.index({ source: 1 });

// Static methods
ruleSchema.statics.findByLanguage = function(languages) {
  return this.find({
    enabled: true,
    language: { $in: languages }
  });
};

ruleSchema.statics.findByCategory = function(category) {
  return this.find({ 
    category: category,
    enabled: true 
  }).sort({ severity: -1, name: 1 });
};

ruleSchema.statics.getStatistics = function() {
  return this.aggregate([
    {
      $group: {
        _id: {
          category: '$category',
          severity: '$severity'
        },
        count: { $sum: 1 },
        enabled_count: {
          $sum: { $cond: ['$enabled', 1, 0] }
        }
      }
    },
    {
      $group: {
        _id: '$_id.category',
        total: { $sum: '$count' },
        enabled: { $sum: '$enabled_count' },
        by_severity: {
          $push: {
            severity: '$_id.severity',
            count: '$count',
            enabled_count: '$enabled_count'
          }
        }
      }
    }
  ]);
};

// Instance methods
ruleSchema.methods.toYAML = function() {
  const yaml = require('yaml');
  const ruleConfig = {
    rules: [{
      id: this._id,
      languages: this.language,
      message: this.message,
      severity: this.severity,
      patterns: this.patterns
    }]
  };

  if (this.metadata && Object.keys(this.metadata).length > 0) {
    ruleConfig.rules[0].metadata = this.metadata;
  }

  return yaml.stringify(ruleConfig);
};

ruleSchema.methods.testAgainstCode = async function(codeSnippet, language) {
  // This would be implemented in ruleService
  throw new Error('Method should be implemented in ruleService');
};

// Pre-save middleware
ruleSchema.pre('save', function(next) {
  // Generate YAML content if not present
  if (!this.yaml_content) {
    this.yaml_content = this.toYAML();
  }

  // Ensure patterns array is not empty
  if (!this.patterns || this.patterns.length === 0) {
    return next(new Error('At least one pattern is required'));
  }

  // Validate pattern structure
  for (const pattern of this.patterns) {
    const hasPattern = 
      pattern.pattern || 
      pattern['pattern-either'] || 
      pattern['pattern-regex'] ||
      pattern['metavariable-pattern'];
    
    if (!hasPattern) {
      return next(new Error('Each pattern must have at least one pattern type defined'));
    }
  }

  next();
});

module.exports = mongoose.model('SemgrepRule', ruleSchema);