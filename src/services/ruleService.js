const SemgrepRule = require('../models/Rule');
const fs = require('fs-extra');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');

class RuleService {
  constructor() {
    this.rulesPath = process.env.SEMGREP_RULES_PATH || path.join(__dirname, '../../rules');
    this.semgrepRegistryUrl = 'https://semgrep.dev/api/v1/rules';
  }

  // Create a new rule
  async createRule(ruleData) {
    try {
      // Validate rule structure
      this.validateRuleStructure(ruleData);
      
      // Generate YAML content
      const yamlContent = this.generateRuleYAML(ruleData);
      ruleData.yaml_content = yamlContent;
      
      // Create rule in database
      const rule = new SemgrepRule(ruleData);
      await rule.save();
      
      // Save YAML file to filesystem
      await this.saveRuleToFile(rule);
      
      return rule;
    } catch (error) {
      throw new Error(`Failed to create rule: ${error.message}`);
    }
  }

  // Get all rules with filtering options
  async getRules(filter = {}) {
    try {
      const query = {};
      
      // Apply filters
      if (filter.language) {
        query.language = { $in: Array.isArray(filter.language) ? filter.language : [filter.language] };
      }
      
      if (filter.category) {
        query.category = filter.category;
      }
      
      if (filter.severity) {
        query.severity = filter.severity;
      }
      
      if (filter.enabled !== undefined) {
        query.enabled = filter.enabled;
      }
      
      if (filter.source) {
        query.source = filter.source;
      }
      
      // Text search
      if (filter.search) {
        query.$or = [
          { name: { $regex: filter.search, $options: 'i' } },
          { message: { $regex: filter.search, $options: 'i' } },
          { 'metadata.description': { $regex: filter.search, $options: 'i' } }
        ];
      }
      
      const rules = await SemgrepRule.find(query)
        .sort({ category: 1, severity: -1, name: 1 })
        .limit(filter.limit || 100);
      
      return rules;
    } catch (error) {
      throw new Error(`Failed to get rules: ${error.message}`);
    }
  }

  // Get rule by ID
  async getRuleById(ruleId) {
    try {
      const rule = await SemgrepRule.findById(ruleId);
      if (!rule) {
        throw new Error('Rule not found');
      }
      return rule;
    } catch (error) {
      throw new Error(`Failed to get rule: ${error.message}`);
    }
  }

  // Update existing rule
  async updateRule(ruleId, updateData) {
    try {
      const rule = await SemgrepRule.findById(ruleId);
      if (!rule) {
        throw new Error('Rule not found');
      }

      // Update fields
      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined) {
          rule[key] = updateData[key];
        }
      });

      // Validate updated rule
      this.validateRuleStructure(rule.toObject());

      // Regenerate YAML content
      rule.yaml_content = this.generateRuleYAML(rule.toObject());
      rule.updated_by = updateData.updated_by || 'system';

      await rule.save();

      // Update YAML file
      await this.saveRuleToFile(rule);

      return rule;
    } catch (error) {
      throw new Error(`Failed to update rule: ${error.message}`);
    }
  }

  // Delete rule
  async deleteRule(ruleId) {
    try {
      const rule = await SemgrepRule.findById(ruleId);
      if (!rule) {
        throw new Error('Rule not found');
      }

      // Remove from database
      await SemgrepRule.findByIdAndDelete(ruleId);

      // Remove YAML file
      await this.removeRuleFile(rule);

      return true;
    } catch (error) {
      throw new Error(`Failed to delete rule: ${error.message}`);
    }
  }

  // Test rule against sample code
  async testRule(ruleId, testCode, filename = 'test.js') {
    try {
      const rule = await this.getRuleById(ruleId);
      
      // Create temporary files
      const tempDir = path.join(__dirname, '../../temp', `test-${Date.now()}`);
      await fs.ensureDir(tempDir);
      
      const ruleFile = path.join(tempDir, 'rule.yml');
      const codeFile = path.join(tempDir, filename);
      
      // Write rule and code files
      await fs.writeFile(ruleFile, rule.yaml_content);
      await fs.writeFile(codeFile, testCode);
      
      // Run semgrep
      const { spawn } = require('child_process');
      const results = await new Promise((resolve, reject) => {
        const semgrep = spawn('semgrep', [
          '--config', ruleFile,
          '--json',
          '--no-git-ignore',
          codeFile
        ]);

        let output = '';
        let errorOutput = '';

        semgrep.stdout.on('data', (data) => {
          output += data.toString();
        });

        semgrep.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        semgrep.on('close', (code) => {
          // Clean up temp files
          fs.remove(tempDir).catch(() => {});
          
          if (code === 0 || code === 1) { // 1 means findings found
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

        // Timeout after 30 seconds
        setTimeout(() => {
          semgrep.kill();
          reject(new Error('Rule test timeout'));
        }, 30000);
      });
      
      return {
        rule_id: ruleId,
        test_code: testCode,
        filename: filename,
        matches: results.length,
        results: results
      };
    } catch (error) {
      throw new Error(`Failed to test rule: ${error.message}`);
    }
  }

  // Import rules from semgrep registry
  async importFromRegistry(ruleIds = [], category = null) {
    try {
      let importedRules = [];
      
      if (category) {
        // Import all rules from a category
        importedRules = await this.importCategoryRules(category);
      } else if (ruleIds.length > 0) {
        // Import specific rules
        for (const ruleId of ruleIds) {
          try {
            const rule = await this.importSingleRule(ruleId);
            importedRules.push(rule);
          } catch (error) {
            console.warn(`Failed to import rule ${ruleId}: ${error.message}`);
          }
        }
      }
      
      return importedRules;
    } catch (error) {
      throw new Error(`Failed to import rules: ${error.message}`);
    }
  }

  // Import single rule from registry
  async importSingleRule(ruleId) {
    try {
      const response = await axios.get(`${this.semgrepRegistryUrl}/${ruleId}`);
      const ruleData = response.data;
      
      // Convert registry format to our format
      const convertedRule = this.convertRegistryRule(ruleData);
      
      // Check if rule already exists
      const existingRule = await SemgrepRule.findById(convertedRule._id);
      if (existingRule) {
        throw new Error(`Rule ${ruleId} already exists`);
      }
      
      // Create rule
      const rule = new SemgrepRule(convertedRule);
      await rule.save();
      
      // Save YAML file
      await this.saveRuleToFile(rule);
      
      return rule;
    } catch (error) {
      throw new Error(`Failed to import rule ${ruleId}: ${error.message}`);
    }
  }

  // Load default rules from filesystem
  async loadDefaultRules() {
    try {
      const defaultRulesDir = path.join(__dirname, '../../rules');
      
      if (!await fs.pathExists(defaultRulesDir)) {
        console.log('Creating default rules directory...');
        await fs.ensureDir(defaultRulesDir);
        await this.createDefaultRules();
        return;
      }
      
      const categories = await fs.readdir(defaultRulesDir);
      let loadedCount = 0;
      
      for (const category of categories) {
        const categoryPath = path.join(defaultRulesDir, category);
        const stat = await fs.stat(categoryPath);
        
        if (stat.isDirectory()) {
          const ruleFiles = await fs.readdir(categoryPath);
          
          for (const filename of ruleFiles) {
            if (filename.endsWith('.yml') || filename.endsWith('.yaml')) {
              try {
                const filePath = path.join(categoryPath, filename);
                await this.loadRuleFromFile(filePath, category);
                loadedCount++;
              } catch (error) {
                console.warn(`Failed to load rule file ${filename}: ${error.message}`);
              }
            }
          }
        }
      }
      
      console.log(`✅ Loaded ${loadedCount} default rules`);
    } catch (error) {
      console.error(`Failed to load default rules: ${error.message}`);
    }
  }

  // Load single rule from YAML file
  async loadRuleFromFile(filePath, category) {
    try {
      const yamlContent = await fs.readFile(filePath, 'utf8');
      const parsed = yaml.parse(yamlContent);
      
      if (!parsed.rules || !Array.isArray(parsed.rules)) {
        throw new Error('Invalid rule file format');
      }
      
      for (const ruleConfig of parsed.rules) {
        const ruleData = {
          _id: ruleConfig.id,
          name: ruleConfig.message || ruleConfig.id,
          language: ruleConfig.languages || ['javascript'],
          severity: ruleConfig.severity || 'WARNING',
          category: category || 'correctness',
          patterns: ruleConfig.patterns || [{ pattern: ruleConfig.pattern }],
          message: ruleConfig.message,
          metadata: ruleConfig.metadata || {},
          yaml_content: yamlContent,
          source: 'imported'
        };
        
        // Check if rule already exists
        const existingRule = await SemgrepRule.findById(ruleData._id);
        if (!existingRule) {
          const rule = new SemgrepRule(ruleData);
          await rule.save();
        }
      }
    } catch (error) {
      throw new Error(`Failed to load rule from file: ${error.message}`);
    }
  }

  // Generate YAML content from rule data
  generateRuleYAML(ruleData) {
    const rule = {
      rules: [{
        id: ruleData._id,
        languages: ruleData.language,
        message: ruleData.message,
        severity: ruleData.severity,
        patterns: ruleData.patterns
      }]
    };
    
    if (ruleData.metadata && Object.keys(ruleData.metadata).length > 0) {
      rule.rules[0].metadata = ruleData.metadata;
    }
    
    return yaml.stringify(rule);
  }

  // Validate rule structure
  validateRuleStructure(ruleData) {
    if (!ruleData._id) {
      throw new Error('Rule ID is required');
    }
    
    if (!ruleData.name) {
      throw new Error('Rule name is required');
    }
    
    if (!ruleData.language || ruleData.language.length === 0) {
      throw new Error('At least one language must be specified');
    }
    
    if (!ruleData.patterns || ruleData.patterns.length === 0) {
      throw new Error('At least one pattern must be specified');
    }
    
    // Validate patterns
    for (const pattern of ruleData.patterns) {
      if (!pattern.pattern && !pattern['pattern-either'] && !pattern['metavariable-pattern']) {
        throw new Error('Each pattern must have at least one pattern type');
      }
    }
    
    return true;
  }

  // Save rule to YAML file
  async saveRuleToFile(rule) {
    try {
      const categoryDir = path.join(this.rulesPath, rule.category);
      await fs.ensureDir(categoryDir);
      
      const filename = `${rule._id}.yml`;
      const filePath = path.join(categoryDir, filename);
      
      await fs.writeFile(filePath, rule.yaml_content);
    } catch (error) {
      console.warn(`Failed to save rule file: ${error.message}`);
    }
  }

  // Remove rule file
  async removeRuleFile(rule) {
    try {
      const categoryDir = path.join(this.rulesPath, rule.category);
      const filename = `${rule._id}.yml`;
      const filePath = path.join(categoryDir, filename);
      
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
      }
    } catch (error) {
      console.warn(`Failed to remove rule file: ${error.message}`);
    }
  }

  // Convert semgrep registry rule to our format
  convertRegistryRule(registryRule) {
    return {
      _id: registryRule.id,
      name: registryRule.message || registryRule.id,
      language: registryRule.languages,
      severity: registryRule.severity || 'WARNING',
      category: this.inferCategory(registryRule),
      patterns: registryRule.patterns || [{ pattern: registryRule.pattern }],
      message: registryRule.message,
      metadata: registryRule.metadata || {},
      source: 'semgrep-registry',
      yaml_content: yaml.stringify({ rules: [registryRule] })
    };
  }

  // Infer category from rule metadata or ID
  inferCategory(rule) {
    const id = rule.id.toLowerCase();
    const message = (rule.message || '').toLowerCase();
    
    if (id.includes('security') || message.includes('security') || 
        id.includes('xss') || id.includes('sql-injection') || id.includes('csrf')) {
      return 'security';
    }
    
    if (id.includes('performance') || message.includes('performance')) {
      return 'performance';
    }
    
    if (id.includes('style') || message.includes('style') || id.includes('lint')) {
      return 'style';
    }
    
    return 'correctness';
  }

  // Create some default rules for testing
  async createDefaultRules() {
    const defaultRules = [
      {
        _id: 'hardcoded-password',
        name: 'Hardcoded Password Detection',
        language: ['javascript', 'typescript', 'python'],
        severity: 'ERROR',
        category: 'security',
        patterns: [
          { pattern: 'password = "$VALUE"' },
          { pattern: 'pwd = "$VALUE"' },
          { pattern: 'pass = "$VALUE"' }
        ],
        message: 'Hardcoded password detected in source code',
        metadata: {
          cwe: 'CWE-798',
          description: 'Hardcoded passwords in source code can be easily discovered and exploited'
        }
      },
      {
        _id: 'eval-usage',
        name: 'Dangerous eval() Usage',
        language: ['javascript', 'typescript'],
        severity: 'ERROR',
        category: 'security',
        patterns: [
          { pattern: 'eval($X)' }
        ],
        message: 'Use of eval() can lead to code injection vulnerabilities',
        metadata: {
          cwe: 'CWE-94',
          description: 'The eval() function executes arbitrary code and should be avoided'
        }
      }
    ];

    for (const ruleData of defaultRules) {
      try {
        await this.createRule(ruleData);
      } catch (error) {
        console.warn(`Failed to create default rule ${ruleData._id}: ${error.message}`);
      }
    }
  }
}

module.exports = new RuleService();