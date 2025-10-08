const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const ScanJob = require('../models/ScanJob');
const scanService = require('../services/scanService');
const githubService = require('../services/githubService'); 
const { ensureAuthenticated } = require('./auth'); // NEW: Import Auth Middleware
const multer = require('multer'); // NEW: Untuk upload file
const fs = require('fs-extra'); // NEW
const path = require('path'); // NEW
const { v4: uuidv4 } = require('uuid'); // NEW
const AdmZip = require('adm-zip'); // NEW: Untuk ekstraksi ZIP

// Konfigurasi Multer untuk upload file lokal
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Simpan file zip di direktori 'uploads'
        cb(null, path.join(__dirname, '../../uploads'));
    },
    filename: (req, file, cb) => {
        cb(null, `${uuidv4()}-${file.originalname}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // Batas 50MB
}).single('project_zip'); // Nama field yang diharapkan dari form

// GET /api/projects - Get all projects
router.get('/', async (req, res) => {
  try {
    const filter = {};
    const options = {
      sort: { created_at: -1 },
      limit: parseInt(req.query.limit) || 50
    };

    // Apply filters
    if (req.query.owner) {
      filter.owner = req.query.owner;
    }
    
    if (req.query.status) {
      filter.status = req.query.status;
    }
    
    if (req.query.auto_scan !== undefined) {
      filter.auto_scan = req.query.auto_scan === 'true';
    }

    // Search functionality
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { repo_url: { $regex: req.query.search, $options: 'i' } },
        { description: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const projects = await Project.find(filter, null, options);
    
    res.json({
      success: true,
      count: projects.length,
      data: projects.map(project => ({
        ...project.toObject(),
        github_info: project.github_info,
        scan_health_score: project.scan_health_score
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/projects/:id - Get specific project
router.get('/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Get recent scan jobs
    const recentScans = await ScanJob.findByProject(req.params.id, 10);
    
    res.json({
      success: true,
      data: {
        ...project.toObject(),
        github_info: project.github_info,
        scan_health_score: project.scan_health_score,
        recent_scans: recentScans
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/projects/github/repos - Get user's GitHub repositories (ENDPOINT BARU)
router.get('/github/repos', ensureAuthenticated, async (req, res) => {
  try {
    // req.user tersedia karena ensureAuthenticated sudah berjalan
    const accessToken = req.user.access_token; 
    
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated with GitHub or missing access token.'
      });
    }

    const repositories = await githubService.getUserRepositories(accessToken);
    
    res.json({
      success: true,
      count: repositories.length,
      data: repositories
    });
  } catch (error) {
    console.error('❌ Failed to fetch user repositories:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/projects - Create new project
router.post('/', ensureAuthenticated, async (req, res) => {
  try {
    const projectData = {
      ...req.body,
      created_by: req.user.username || 'api', 
      owner: req.user.username || 'unknown' // Set owner to the logged-in user
    };

    // Validasi GitHub URL format
    if (!projectData.repo_url || !projectData.repo_url.includes('github.com')) {
      return res.status(400).json({
        success: false,
        error: 'Valid GitHub repository URL is required'
      });
    }

    const project = new Project(projectData);
    await project.save();
    
    res.status(201).json({
      success: true,
      message: 'Project created successfully',
      data: {
        ...project.toObject(),
        github_info: project.github_info
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({
        success: false,
        error: 'Repository URL already exists'
      });
    } else {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
});

// POST /api/projects/upload/scan - Upload folder and trigger scan (NEW ROUTE: Requires Authentication)
router.post('/upload/scan', ensureAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(500).json({ success: false, error: `Unknown error: ${err.message}` });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'File upload is required (field: project_zip)' });
        }
        
        if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
            await fs.remove(req.file.path); // Bersihkan file non-zip
            return res.status(400).json({ success: false, error: 'Only ZIP files are supported for project upload.' });
        }

        const zipFilePath = req.file.path;
        // Buat folder unik untuk ekstraksi di direktori temp
        const scanDirName = `local-scan-${uuidv4()}`;
        const scanDirPath = path.join(__dirname, '../../temp', scanDirName);

        try {
            // 1. Ekstraksi file ZIP
            await fs.ensureDir(scanDirPath);
            const zip = new AdmZip(zipFilePath);
            zip.extractAllTo(scanDirPath, true);

            // 2. Hapus file ZIP yang asli
            await fs.remove(zipFilePath);

            // 3. Buat dan antrikan scan job (isLocalScan = true)
            const triggerData = {
                source: 'local-upload',
                event: 'file_upload',
                priority: 8,
                branch: 'local-scan',
                commit_sha: 'local-scan-commit',
                metadata: {
                    triggered_by: req.user.username,
                    original_file: req.file.originalname,
                },
                local_path: scanDirPath // Path folder yang akan di scan
            };
            
            // Project ID adalah null karena ini adalah scan sementara
            const scanJob = await scanService.createScanJob(null, triggerData, true); 
            
            res.status(201).json({
                success: true,
                message: 'Project uploaded, extracted, and scan job queued',
                data: scanJob
            });

        } catch (error) {
            console.error('Local scan processing error:', error);
            // Bersihkan file dan folder jika terjadi error
            await fs.remove(zipFilePath).catch(() => {});
            await fs.remove(scanDirPath).catch(() => {});
            res.status(500).json({
                success: false,
                error: `Failed to process uploaded project: ${error.message}`
            });
        }
    });
});

// PUT /api/projects/:id - Update project (MODIFIED: Requires Authentication)
router.put('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Update fields
    Object.keys(req.body).forEach(key => {
      if (req.body[key] !== undefined && key !== '_id') {
        project[key] = req.body[key];
      }
    });

    project.updated_by = req.user.username || 'api'; // Set updated_by
    await project.save();
    
    res.json({
      success: true,
      message: 'Project updated successfully',
      data: {
        ...project.toObject(),
        github_info: project.github_info
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE /api/projects/:id - Delete project (MODIFIED: Requires Authentication)
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Cancel any pending scans
    const pendingScans = await ScanJob.find({
      project_id: req.params.id,
      status: { $in: ['pending', 'queued', 'running'] }
    });

    for (const scan of pendingScans) {
      try {
        await scanService.cancelScan(scan._id.toString());
      } catch (cancelError) {
        console.warn(`Failed to cancel scan ${scan._id}: ${cancelError.message}`);
      }
    }

    await Project.findByIdAndDelete(req.params.id);
    
    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/projects/:id/scan - Trigger manual scan (MODIFIED: Requires Auth and passes user token)
router.post('/:id/scan', ensureAuthenticated, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (project.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Project must be active to trigger scans'
      });
    }

    // Check for existing active scans
    const activeScans = await ScanJob.find({
      project_id: req.params.id,
      status: { $in: ['pending', 'queued', 'running'] }
    });

    if (activeScans.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Another scan is already running for this project'
      });
    }

    const triggerData = {
      source: 'manual',
      event: 'manual_trigger',
      priority: req.body.priority || 5,
      branch: req.body.branch || project.branch,
      commit_sha: req.body.commit_sha,
      // Pass GitHub access token for cloning private repositories
      user_access_token: req.user.access_token, 
      metadata: {
        triggered_by: req.user.username || 'api',
        trigger_reason: req.body.reason || 'Manual scan requested'
      }
    };

    const scanJob = await scanService.createScanJob(req.params.id, triggerData);
    
    res.status(201).json({
      success: true,
      message: 'Scan job created and queued',
      data: scanJob
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/projects/:id/scans - Get project scan history
router.get('/:id/scans', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status;
    
    let filter = { project_id: req.params.id };
    if (status) {
      filter.status = status;
    }

    const scans = await ScanJob.find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .populate('project_id', 'name repo_url');
    
    res.json({
      success: true,
      count: scans.length,
      data: scans
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/projects/:id/stats - Get project statistics
router.get('/:id/stats', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Get scan statistics
    const scanStats = await ScanJob.getStatistics({ project_id: req.params.id });
    
    // Get recent trends (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentScans = await ScanJob.find({
      project_id: req.params.id,
      created_at: { $gte: thirtyDaysAgo }
    }).sort({ created_at: 1 });

    // Calculate trend data
    const trendData = recentScans.map(scan => ({
      date: scan.created_at.toISOString().split('T')[0],
      findings: scan.summary?.total_findings || 0,
      scan_time_ms: scan.scan_time_ms || 0,
      status: scan.status
    }));

    res.json({
      success: true,
      data: {
        project_stats: {
          ...project.statistics,
          scan_health_score: project.scan_health_score
        },
        scan_stats: scanStats,
        trend_data: trendData,
        summary: {
          total_scans: project.statistics.total_scans,
          avg_scan_time: project.statistics.avg_scan_time_ms,
          last_scan: project.statistics.last_scan_at,
          total_findings: project.statistics.total_findings
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/projects/:id/config - Update scan configuration (MODIFIED: Requires Authentication)
router.put('/:id/config', ensureAuthenticated, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Update scan configuration
    if (req.body.scan_config) {
      project.scan_config = { ...project.scan_config, ...req.body.scan_config };
    }

    // Update other configuration fields
    ['auto_scan', 'scan_schedule'].forEach(field => {
      if (req.body[field] !== undefined) {
        project[field] = req.body[field];
      }
    });

    project.updated_by = req.user.username || 'api'; // Set updated_by
    await project.save();
    
    res.json({
      success: true,
      message: 'Project configuration updated successfully',
      data: project
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/projects/:id/archive - Archive project
router.post('/:id/archive', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    project.status = 'archived';
    project.updated_by = req.headers['x-user-id'] || 'api';
    await project.save();
    
    // Cancel any pending scans
    const pendingScans = await ScanJob.find({
      project_id: req.params.id,
      status: { $in: ['pending', 'queued', 'running'] }
    });

    for (const scan of pendingScans) {
      try {
        await scanService.cancelScan(scan._id.toString());
      } catch (cancelError) {
        console.warn(`Failed to cancel scan ${scan._id}: ${cancelError.message}`);
      }
    }
    
    res.json({
      success: true,
      message: 'Project archived successfully',
      data: project
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/projects/:id/restore - Restore archived project
router.post('/:id/restore', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    project.status = 'active';
    project.updated_by = req.headers['x-user-id'] || 'api';
    await project.save();
    
    res.json({
      success: true,
      message: 'Project restored successfully',
      data: project
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/projects/stats/overview - Get overview statistics for all projects
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await Project.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          total_scans: { $sum: '$statistics.total_scans' },
          total_findings: { $sum: '$statistics.total_findings' }
        }
      }
    ]);

    const overview = {
      total_projects: 0,
      active_projects: 0,
      archived_projects: 0,
      total_scans: 0,
      total_findings: 0
    };

    stats.forEach(stat => {
      overview.total_projects += stat.count;
      overview.total_scans += stat.total_scans || 0;
      overview.total_findings += stat.total_findings || 0;
      
      if (stat._id === 'active') {
        overview.active_projects = stat.count;
      } else if (stat._id === 'archived') {
        overview.archived_projects = stat.count;
      }
    });

    res.json({
      success: true,
      data: overview
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;