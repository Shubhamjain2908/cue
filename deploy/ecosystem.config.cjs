/**
 * PM2 process file — Cue only.
 *
 * Secrets live in /opt/cue/.env (chmod 600, owned by deploy user).
 * No build step — tsx executes pipeline.ts directly.
 *
 * First deploy:
 *   cd /opt/cue
 *   pnpm install
 *   mkdir -p logs
 *   cp .env.example .env && chmod 600 .env  # fill in values
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup  # re-run startup only if not already done
 *
 * Subsequent deploys:
 *   git pull && pm2 reload cue --update-env
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const logDir = path.join(root, 'logs');

module.exports = {
  apps: [
    {
      name: 'cue',
      cwd: root,
      // tsx executes pipeline.ts directly — no build step required.
      // pipeline.ts runs a setInterval scheduler loop (per §3); this process
      // is long-lived and should never exit cleanly under normal operation.
      script: 'node_modules/.bin/tsx',
      args: 'src/agents/daily-workflow.ts',
      interpreter: 'none', // tsx is the interpreter — don't wrap with node
      instances: 1,
      autorestart: true,
      max_restarts: 10,     // tighter than typical: repeated crashes = config
      min_uptime: '30s',    // or data fault, not a transient flap
      restart_delay: 15000, // 15s back-off before PM2 retries
      env_file: path.join(root, '.env'),
      env: {
        NODE_ENV: 'production',
      },
      merge_logs: true,
      combine_logs: true,
      out_file: path.join(logDir, 'pm2-cue.log'),
      error_file: path.join(logDir, 'pm2-cue.log'),
      time: true,
    },
  ],
};
