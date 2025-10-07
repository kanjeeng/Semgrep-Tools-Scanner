const express = require('express');
const router = express.Router();
const ruleService = require('../services/ruleService');

// GET /api/rules - Get all rules with filtering
router.get('/', async (req, res) => {
  try {
    const filter = {
      language: req.query.language ? req.query.language.split(',') : undefined,
      category: req.query.category,
      severity: req.query.severity,
      enabled: req.query.enabled !== undefined ? req.query.enabled === 'true' : undefined,
      source: req.query.source,
      search: req.query.search,
      limit: parseInt(req.query.limit) || 100
    };

    // Remove undefined values
    Object.keys(filter).forEach(key => filter[key] === undefined && delete filter[key]);

    const rules = await ruleService.getRules(filter);
    
    res.json({
      success: true,
      count: rules.length,
      data: rules,
      filter: filter
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/rules/:id - Get specific rule
router.get('/:id', async (req, res) => {
  try {
    const rule = await ruleService.getRuleById(req.params.id);
    
    res.json({
      success: true,
      data: rule
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rules - Create new rule
router.post('/', async (req, res) => {
  try {
    const ruleData = {
      ...req.body,
      created_by: req.headers['x-user-id'] || 'api',
      source: 'custom'
    };

    const rule = await ruleService.createRule(ruleData);
    
    res.status(201).json({
      success: true,
      message: 'Rule created successfully',
      data: rule
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/rules/:id - Update existing rule
router.put('/:id', async (req, res) => {
  try {
    const updateData = {
      ...req.body,
      updated_by: req.headers['x-user-id'] || 'api'
    };

    const rule = await ruleService.updateRule(req.params.id, updateData);
    
    res.json({
      success: true,
      message: 'Rule updated successfully',
      data: rule
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE /api/rules/:id - Delete rule
router.delete('/:id', async (req, res) => {
  try {
    await ruleService.deleteRule(req.params.id);
    
    res.json({
      success: true,
      message: 'Rule deleted successfully'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rules/:id/test - Test rule against sample code
router.post('/:id/test', async (req, res) => {
  try {
    const { code, filename } = req.body;
    
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Test code is required'
      });
    }

    const result = await ruleService.testRule(
      req.params.id, 
      code, 
      filename || 'test.js'
    );
    
    res.json({
      success: true,
      message: `Rule test completed - ${result.matches} matches found`,
      data: result
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rules/import - Import rules from semgrep registry
router.post('/import', async (req, res) => {
  try {
    const { rule_ids, category } = req.body;
    
    if (!rule_ids && !category) {
      return res.status(400).json({
        success: false,
        error: 'Either rule_ids array or category must be provided'
      });
    }

    const importedRules = await ruleService.importFromRegistry(rule_ids || [], category);
    
    res.json({
      success: true,
      message: `Successfully imported ${importedRules.length} rules`,
      data: importedRules
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rules/bulk-update - Bulk update rules
router.post('/bulk-update', async (req, res) => {
  try {
    const { rule_ids, updates } = req.body;
    
    if (!rule_ids || !Array.isArray(rule_ids) || rule_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'rule_ids array is required'
      });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'updates object is required'
      });
    }

    const results = [];
    const errors = [];

    for (const ruleId of rule_ids) {
      try {
        const rule = await ruleService.updateRule(ruleId, {
          ...updates,
          updated_by: req.headers['x-user-id'] || 'api'
        });
        results.push(rule);
      } catch (error) {
        errors.push({ rule_id: ruleId, error: error.message });
      }
    }

    res.json({
      success: true,
      message: `Bulk update completed: ${results.length} successful, ${errors.length} failed`,
      data: {
        updated: results,
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

// GET /api/rules/categories/stats - Get statistics by category
router.get('/categories/stats', async (req, res) => {
  try {
    const stats = await ruleService.getRules();
    
    const categoryStats = stats.reduce((acc, rule) => {
      if (!acc[rule.category]) {
        acc[rule.category] = {
          total: 0,
          enabled: 0,
          by_severity: { INFO: 0, WARNING: 0, ERROR: 0 },
          by_language: {}
        };
      }
      
      acc[rule.category].total++;
      if (rule.enabled) acc[rule.category].enabled++;
      acc[rule.category].by_severity[rule.severity]++;
      
      rule.language.forEach(lang => {
        if (!acc[rule.category].by_language[lang]) {
          acc[rule.category].by_language[lang] = 0;
        }
        acc[rule.category].by_language[lang]++;
      });
      
      return acc;
    }, {});

    res.json({
      success: true,
      data: categoryStats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/rules/validate - Validate rule structure without saving
router.post('/validate', async (req, res) => {
  try {
    ruleService.validateRuleStructure(req.body);
    
    // Generate preview YAML
    const yamlPreview = ruleService.generateRuleYAML(req.body);
    
    res.json({
      success: true,
      message: 'Rule structure is valid',
      data: {
        valid: true,
        yaml_preview: yamlPreview
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
      data: {
        valid: false
      }
    });
  }
});

module.exports = router;