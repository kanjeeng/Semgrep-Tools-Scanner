const axios = require('axios');
const crypto = require('crypto');

class GitHubService {
  constructor() {
    this.baseURL = 'https://api.github.com';
    this.token = process.env.GITHUB_TOKEN;
    this.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    this.defaultApi = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': this.token ? `token ${this.token}` : '',
        'Accept': 'application/vnd.github.com.v3+json',
        'User-Agent': 'source-code-analyzer'
      }
    });
  }

  // Utility untuk mendapatkan instance Axios dengan token dinamis (token user)
  getApiInstance(userToken) {
    if (userToken) {
        return axios.create({
            baseURL: this.baseURL,
            headers: {
                // Menggunakan token user untuk Authorization
                'Authorization': `token ${userToken}`, 
                'Accept': 'application/vnd.github.com.v3+json',
                'User-Agent': 'source-code-analyzer'
            }
        });
    }
    // Fallback ke default API jika token user tidak disediakan
    return this.defaultApi;
  }

  // Metode Baru: Mengambil repositori milik user yang login
  async getUserRepositories(userAccessToken) {
    if (!userAccessToken) {
      throw new Error('User access token is required to fetch repositories.');
    }
    
    // Gunakan instance yang diautentikasi dengan token pengguna
    const api = this.getApiInstance(userAccessToken);

    try {
      // Mengambil daftar repo, termasuk yang private.
      const response = await api.get('/user/repos', {
        params: {
          per_page: 100,
          affiliation: 'owner,collaborator,organization_member' // Mendapatkan semua repo yang user miliki akses
        }
      });
      
      // Memfilter data yang relevan
      return response.data.map(repo => ({
        id: repo.id,
        name: repo.full_name,
        html_url: repo.html_url,
        is_private: repo.private,
        default_branch: repo.default_branch,
        description: repo.description,
        owner: repo.owner.login
      }));

    } catch (error) {
      if (error.response && error.response.status === 422) {
          console.error("GitHub API 422 Error Details (FIXED PARAMETERS):", error.response.data);
          throw new Error('Failed to fetch user repositories: GitHub API request parameters conflict.');
      }
      if (error.response && error.response.status === 401) {
        throw new Error('Unauthorized access to GitHub API. Token invalid or expired.');
      }
      throw new Error(`Failed to fetch user repositories: GitHub API error (${error.response ? error.response.status : 'No Response'}).`);
    }
  }

  // Validate GitHub repository access (MENGGUNAKAN DEFAULT API, tidak diubah)
  async validateRepository(repoUrl) {
    try {
      const { owner, repo } = this.extractRepoInfo(repoUrl);
      const response = await this.defaultApi.get(`/repos/${owner}/${repo}`); 
      
      return {
        owner: response.data.owner.login,
        repo: response.data.name,
        default_branch: response.data.default_branch,
        private: response.data.private,
        has_issues: response.data.has_issues,
        has_projects: response.data.has_projects,
        has_wiki: response.data.has_wiki,
        size: response.data.size,
        language: response.data.language
      };
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error('Repository not found or access denied');
      }
      throw new Error(`GitHub API error: ${error.message}`);
    }
  }

  // Create webhook for a project
  async createWebhook(project) {
    if (!this.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const { owner, repo } = this.extractRepoInfo(project.repo_url);
      const webhookUrl = `${process.env.APP_URL || 'http://localhost:3000'}/webhooks/github`;
      // Create webhook
      const response = await this.defaultApi.post(`/repos/${owner}/${repo}/hooks`, {
        name: 'web',
        active: true,
        events: ['push', 'pull_request'],
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: project.webhook_secret,
          insecure_ssl: process.env.NODE_ENV === 'development' ? '1' : '0'
        }
      });

      // Update project with webhook ID
      project.github_config.webhook_id = response.data.id;
      await project.save();

      return response.data;
    } catch (error) {
      if (error.response?.data?.message?.includes('already exists')) {
        throw new Error('Webhook already exists for this repository');
      }
      throw new Error(`Failed to create webhook: ${error.message}`);
    }
  }

  // Delete webhook
  async deleteWebhook(project) {
    if (!this.token || !project.github_config.webhook_id) {
      return;
    }

    try {
      const { owner, repo } = this.extractRepoInfo(project.repo_url);
      await this.defaultApi.delete(`/repos/${owner}/${repo}/hooks/${project.github_config.webhook_id}`);
      
      // Remove webhook ID from project
      project.github_config.webhook_id = null;
      await project.save();
    } catch (error) {
      console.warn(`Failed to delete webhook: ${error.message}`);
    }
  }

  // Verify webhook signature
  verifyWebhookSignature(signature, payload) {
    if (!this.webhookSecret) {
      console.warn('⚠️  Webhook secret not configured, skipping signature verification');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
    
    const actualSignature = signature.replace('sha256=', '');
    
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(actualSignature)
    );
  }

  // Post comment on pull request
  async postPRComment(project, prNumber, comment) {
    if (!this.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const { owner, repo } = this.extractRepoInfo(project.repo_url);
      const response = await this.defaultApi.post(
        `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { body: comment }
      );

      return response.data;
    } catch (error) {
      throw new Error(`Failed to post PR comment: ${error.message}`);
    }
  }

  // Get pull request information
  async getPullRequest(project, prNumber) {
    if (!this.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const { owner, repo } = this.extractRepoInfo(project.repo_url);
      const response = await this.defaultApi.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get PR information: ${error.message}`);
    }
  }

  // Get repository languages
  async getRepositoryLanguages(project) {
    try {
      const { owner, repo } = this.extractRepoInfo(project.repo_url);
      const response = await this.defaultApi.get(`/repos/${owner}/${repo}/languages`);

      return Object.keys(response.data);
    } catch (error) {
      console.warn(`Failed to get repository languages: ${error.message}`);
      return [];
    }
  }

  // Get repository file structure
  async getRepositoryContents(project, path = '') {
    if (!this.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const { owner, repo } = this.extractRepoInfo(project.repo_url);
      const response = await this.defaultApi.get(`/repos/${owner}/${repo}/contents/${path}`);

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get repository contents: ${error.message}`);
    }
  }

  // Extract owner and repo from URL
  extractRepoInfo(repoUrl) {
    const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/\.]+)/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }
    // Menghilangkan suffix .git
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') }; 
  }

  // Check rate limit status
  async getRateLimit() {
    try {
      const response = await this.defaultApi.get('/rate_limit');
      return response.data;
    } catch (error) {
      console.warn('Failed to get rate limit:', error.message);
      return null;
    }
  }

  // Test GitHub connection
  async testConnection() {
    try {
      const rateLimit = await this.getRateLimit();
      if (!rateLimit) {
        return { connected: false, error: 'Failed to connect to GitHub API' };
      }

      return {
        connected: true,
        rate_limit: rateLimit.rate,
        resources: rateLimit.resources
      };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }
}

module.exports = new GitHubService();