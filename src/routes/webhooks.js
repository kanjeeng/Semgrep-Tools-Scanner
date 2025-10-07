const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Project = require('../models/Project');
const scanService = require('../services/scanService');

// GitHub webhook signature verification middleware
function verifyGitHubSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];
  
  if (!signature) {
    return res.status(401).json({
      success: false,
      error: 'Missing signature header'
    });
  }

  // For development, allow skipping signature verification
  if (process.env.NODE_ENV === 'development' && !process.env.GITHUB_WEBHOOK_SECRET) {
    console.warn('⚠️  Skipping webhook signature verification in development mode');
    return next();
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({
      success: false,
      error: 'Webhook secret not configured'
    });
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  
  const actualSignature = signature.replace('sha256=', '');
  
  if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(actualSignature))) {
    return res.status(401).json({
      success: false,
      error: 'Invalid signature'
    });
  }

  // Add webhook info to request
  req.webhook = {
    event,
    delivery,
    signature
  };
  
  next();
}

// POST /webhooks/github - GitHub webhook endpoint
router.post('/github', verifyGitHubSignature, async (req, res) => {
  try {
    const event = req.webhook.event;
    const payload = req.body;
    const delivery = req.webhook.delivery;

    console.log(`📨 Received GitHub webhook: ${event} (${delivery})`);

    // Handle different GitHub events
    switch (event) {
      case 'push':
        await handlePushEvent(payload, req);
        break;
      case 'pull_request':
        await handlePullRequestEvent(payload, req);
        break;
      case 'ping':
        return res.json({ message: 'pong', webhook_configured: true });
      default:
        console.log(`ℹ️  Ignoring webhook event: ${event}`);
        return res.json({ message: 'Event ignored', event });
    }

    res.json({
      success: true,
      message: 'Webhook processed successfully',
      event,
      delivery
    });
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      event: req.webhook?.event,
      delivery: req.webhook?.delivery
    });
  }
});

// Handle push events
async function handlePushEvent(payload, req) {
  const repoFullName = payload.repository.full_name;
  const branch = payload.ref.replace('refs/heads/', '');
  const commits = payload.commits || [];
  
  if (commits.length === 0) {
    console.log('ℹ️  No commits in push event, skipping');
    return;
  }

  const headCommit = payload.head_commit;
  if (!headCommit) {
    console.log('ℹ️  No head commit in push event, skipping');
    return;
  }

  console.log(`📝 Push to ${repoFullName}:${branch} - ${headCommit.id.substring(0, 7)}`);

  // Find matching project
  const project = await Project.findOne({
    repo_url: { $regex: repoFullName.replace('/', '\\/'), $options: 'i' }
  });

  if (!project) {
    console.log(`ℹ️  No project found for repository: ${repoFullName}`);
    return;
  }

  // Check if we should trigger a scan
  if (!project.shouldTriggerScan('push', branch)) {
    console.log(`ℹ️  Push event ignored for project ${project.name} (branch: ${branch})`);
    return;
  }

  // Check for existing active scans
  const activeScans = await require('../models/ScanJob').find({
    project_id: project._id,
    status: { $in: ['pending', 'queued', 'running'] }
  });

  if (activeScans.length > 0) {
    console.log(`ℹ️  Skipping scan for ${project.name} - another scan is already active`);
    return;
  }

  // Create scan job
  const triggerData = {
    source: 'webhook',
    event: 'push',
    priority: 6, // Higher priority for push events
    branch: branch,
    commit_sha: headCommit.id,
    commit_message: headCommit.message,
    metadata: {
      webhook_payload: {
        repository: payload.repository,
        pusher: payload.pusher,
        head_commit: headCommit,
        commits_count: commits.length,
        delivery_id: req.webhook.delivery
      },
      files_changed: [
        ...(headCommit.added || []),
        ...(headCommit.modified || []),
        ...(headCommit.removed || [])
      ]
    }
  };

  const scanJob = await scanService.createScanJob(project._id, triggerData);
  console.log(`✅ Created scan job ${scanJob._id} for push to ${repoFullName}`);
}

// Handle pull request events
async function handlePullRequestEvent(payload, req) {
  const action = payload.action;
  const repoFullName = payload.repository.full_name;
  const pr = payload.pull_request;
  
  // Only handle opened, synchronize, and reopened events
  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    console.log(`ℹ️  Ignoring pull request action: ${action}`);
    return;
  }

  console.log(`🔀 Pull request ${action} on ${repoFullName} #${pr.number}`);

  // Find matching project
  const project = await Project.findOne({
    repo_url: { $regex: repoFullName.replace('/', '\\/'), $options: 'i' }
  });

  if (!project) {
    console.log(`ℹ️  No project found for repository: ${repoFullName}`);
    return;
  }

  // Check if we should trigger a scan
  if (!project.shouldTriggerScan('pull_request', pr.head.ref)) {
    console.log(`ℹ️  Pull request event ignored for project ${project.name}`);
    return;
  }

  // For synchronize events, cancel previous scans for the same PR
  if (action === 'synchronize') {
    const existingScans = await require('../models/ScanJob').find({
      project_id: project._id,
      pr_number: pr.number,
      status: { $in: ['pending', 'queued', 'running'] }
    });

    for (const scan of existingScans) {
      try {
        await scanService.cancelScan(scan._id.toString());
        console.log(`⏹️  Cancelled previous scan ${scan._id} for PR #${pr.number}`);
      } catch (error) {
        console.warn(`Failed to cancel scan ${scan._id}: ${error.message}`);
      }
    }
  }

  // Create scan job for pull request
  const triggerData = {
    source: 'webhook',
    event: 'pull_request',
    priority: 7, // High priority for PR events
    branch: pr.head.ref,
    commit_sha: pr.head.sha,
    commit_message: pr.title,
    pr_number: pr.number,
    pr_title: pr.title,
    pr_author: pr.user.login,
    metadata: {
      webhook_payload: {
        action,
        repository: payload.repository,
        pull_request: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          user: pr.user,
          head: pr.head,
          base: pr.base,
          html_url: pr.html_url
        },
        delivery_id: req.webhook.delivery
      },
      pr_context: {
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state
      }
    }
  };

  const scanJob = await scanService.createScanJob(project._id, triggerData);
  console.log(`✅ Created scan job ${scanJob._id} for PR #${pr.number} on ${repoFullName}`);

  // If this is a new PR, we might want to post a comment
  if (action === 'opened' && process.env.GITHUB_TOKEN) {
    try {
      await postInitialPRComment(project, pr, scanJob);
    } catch (error) {
      console.warn(`Failed to post initial PR comment: ${error.message}`);
    }
  }
}

// Post initial comment on PR
async function postInitialPRComment(project, pr, scanJob) {
  const axios = require('axios');
  
  const comment = `## 🔍 Source Code Analysis Started

Hi @${pr.user.login}! I've started analyzing your pull request for security vulnerabilities and code quality issues.

**Scan Details:**
- **Scan ID:** \`${scanJob._id}\`
- **Branch:** \`${pr.head.ref}\`
- **Commit:** \`${pr.head.sha.substring(0, 7)}\`

I'll post the results here when the analysis is complete. This usually takes 1-3 minutes.

---
*Powered by [Source Code Analyzer](${process.env.FRONTEND_URL || 'http://localhost:3000'})*`;

  const url = `https://api.github.com/repos/${project.github_config.owner}/${project.github_config.repo}/issues/${pr.number}/comments`;
  
  await axios.post(url, { body: comment }, {
    headers: {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'source-code-analyzer'
    }
  });

  console.log(`💬 Posted initial comment on PR #${pr.number}`);
}

// POST /webhooks/github/test - Test webhook endpoint
router.post('/github/test', async (req, res) => {
  try {
    const testPayload = req.body || {
      repository: {
        full_name: 'test/repository',
        name: 'repository'
      },
      ref: 'refs/heads/main',
      head_commit: {
        id: 'abc123def456',
        message: 'Test commit for webhook',
        added: ['test.js'],
        modified: [],
        removed: []
      },
      pusher: {
        name: 'test-user'
      }
    };

    console.log('🧪 Processing test webhook payload');

    // Process as push event
    await handlePushEvent(testPayload, { 
      webhook: { 
        event: 'push', 
        delivery: 'test-' + Date.now() 
      } 
    });

    res.json({
      success: true,
      message: 'Test webhook processed successfully',
      payload: testPayload
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /webhooks/github/config - Get webhook configuration info
router.get('/github/config', async (req, res) => {
  try {
    const projects = await Project.find({ status: 'active', auto_scan: true })
      .select('name repo_url webhook_secret github_config')
      .limit(10);

    const config = {
      webhook_url: `${req.protocol}://${req.get('host')}/webhooks/github`,
      secret_configured: !!process.env.GITHUB_WEBHOOK_SECRET,
      github_token_configured: !!process.env.GITHUB_TOKEN,
      active_projects: projects.length,
      supported_events: ['push', 'pull_request', 'ping'],
      projects: projects.map(project => ({
        id: project._id,
        name: project.name,
        repo_url: project.repo_url,
        has_webhook_secret: !!project.webhook_secret,
        github_info: project.github_config
      }))
    };

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /webhooks/manual-trigger - Manual webhook trigger for testing
router.post('/manual-trigger', async (req, res) => {
  try {
    const { project_id, event_type, branch, commit_sha } = req.body;

    if (!project_id) {
      return res.status(400).json({
        success: false,
        error: 'project_id is required'
      });
    }

    const project = await Project.findById(project_id);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    const triggerData = {
      source: 'webhook',
      event: event_type || 'manual_trigger',
      priority: 5,
      branch: branch || project.branch,
      commit_sha: commit_sha,
      metadata: {
        manual_trigger: true,
        triggered_by: req.headers['x-user-id'] || 'api',
        trigger_time: new Date().toISOString()
      }
    };

    const scanJob = await scanService.createScanJob(project_id, triggerData);

    res.json({
      success: true,
      message: 'Manual webhook trigger successful',
      data: scanJob
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;