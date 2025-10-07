const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

class SemgrepConfig {
  constructor() {
    this.rulesPath = process.env.SEMGREP_RULES_PATH || path.join(__dirname, '../../rules');
    this.timeout = parseInt(process.env.SEMGREP_TIMEOUT) || 300;
    this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE_KB) || 1024;
    this.supportedLanguages = [
      'javascript', 'typescript', 'python', 'java', 'go', 'rust',
      'cpp', 'c', 'csharp', 'php', 'ruby', 'swift', 'kotlin',
      'scala', 'bash', 'yaml', 'json', 'html', 'css'
    ];
  }

  async validateInstallation() {
    return new Promise((resolve, reject) => {
      const semgrep = spawn('semgrep', ['--version']);
      
      let output = '';
      let errorOutput = '';

      semgrep.stdout.on('data', (data) => {
        output += data.toString();
      });

      semgrep.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      semgrep.on('close', (code) => {
        if (code === 0) {
          const version = output.trim();
          console.log(`✅ Semgrep version: ${version}`);
          resolve({ installed: true, version });
        } else {
          reject(new Error(`Semgrep not installed or not in PATH: ${errorOutput}`));
        }
      });

      semgrep.on('error', (error) => {
        reject(new Error(`Failed to execute semgrep: ${error.message}`));
      });
    });
  }

  getScanCommand(rulesFile, targetPath, options = {}) {
    const args = [
      '--config', rulesFile,
      '--json',
      '--no-git-ignore',
      '--timeout', this.timeout.toString(),
      '--max-target-bytes', (this.maxFileSize * 1024).toString()
    ];

    // Add exclude patterns
    if (options.excludePaths && options.excludePaths.length > 0) {
      options.excludePaths.forEach(pattern => {
        args.push('--exclude', pattern);
      });
    }

    // Add include patterns if specified
    if (options.includePaths && options.includePaths.length > 0) {
      options.includePaths.forEach(pattern => {
        args.push('--include', pattern);
      });
    }

    // Add timeout per rule
    args.push('--timeout-threshold', '3');

    // Target directory
    args.push(targetPath);

    return {
      command: 'semgrep',
      args: args,
      options: {
        cwd: targetPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: (this.timeout + 30) * 1000 // Add 30 seconds buffer
      }
    };
  }

  async validateRulesFile(rulesFile) {
    return new Promise((resolve, reject) => {
      const semgrep = spawn('semgrep', [
        '--validate',
        '--config', rulesFile
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
        if (code === 0) {
          resolve({ valid: true, message: 'Rules file is valid' });
        } else {
          reject(new Error(`Invalid rules file: ${errorOutput || output}`));
        }
      });

      semgrep.on('error', (error) => {
        reject(new Error(`Failed to validate rules: ${error.message}`));
      });
    });
  }

  async getSupportedLanguages() {
    return this.supportedLanguages;
  }

  async checkRuleCoverage(languages) {
    const unsupported = languages.filter(lang => !this.supportedLanguages.includes(lang));
    if (unsupported.length > 0) {
      throw new Error(`Unsupported languages: ${unsupported.join(', ')}`);
    }
    return {
      supported: languages.filter(lang => this.supportedLanguages.includes(lang)),
      unsupported: unsupported
    };
  }

  getDefaultExcludePatterns() {
    return [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.git/**',
      '**/*.min.js',
      '**/*.bundle.js',
      '**/*.map',
      '**/package-lock.json',
      '**/yarn.lock'
    ];
  }

  async cleanupOldScans(olderThanHours = 24) {
    const tempDir = process.env.TEMP_DIR || path.join(__dirname, '../../temp');
    const cutoff = Date.now() - (olderThanHours * 60 * 60 * 1000);

    try {
      const items = await fs.readdir(tempDir);
      let cleanedCount = 0;

      for (const item of items) {
        const itemPath = path.join(tempDir, item);
        const stat = await fs.stat(itemPath);
        
        if (stat.isDirectory() && stat.mtime.getTime() < cutoff) {
          try {
            await fs.remove(itemPath);
            cleanedCount++;
          } catch (removeError) {
            console.warn(`Failed to remove temp directory ${item}: ${removeError.message}`);
          }
        }
      }

      return { cleaned: cleanedCount, total: items.length };
    } catch (error) {
      console.warn(`Failed to cleanup temp directories: ${error.message}`);
      return { cleaned: 0, total: 0, error: error.message };
    }
  }
}

module.exports = new SemgrepConfig();