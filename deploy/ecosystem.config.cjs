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
      // tsx runs the CLI. Prefer `src/cli.ts schedule` (scheduler.ts); `pipeline` without --now is equivalent.
      script: 'node_modules/.bin/tsx',
      args: 'src/cli.ts pipeline',
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
  // PM2 `cron_restart` uses the HOST system timezone (not `TZ` env).
  // Pipeline now runs at 06:00–06:10 ET on Tue–Sun execution days.
  // Oracle Cloud VMs are usually UTC:
  //   `0 11 * * 0,2-6` = 11:00 UTC on Sun/Tue-Sat (~07:00 EDT, ~06:00 EST)
  //     which runs after the morning pipeline window.
  //   If host clock is America/New_York: use `0 7 * * 0,2-6`.
    {
      name: 'cue-healthcheck',
      cwd: root,
      script: 'node_modules/.bin/tsx',
      args: 'src/cli.ts healthcheck',
      interpreter: 'none',
      instances: 1,
      autorestart: false,
      cron_restart: '0 11 * * 0,2-6',
      watch: false,
      env_file: path.join(root, '.env'),
      env: {
        NODE_ENV: 'production',
      },
      merge_logs: true,
      combine_logs: true,
      out_file: path.join(logDir, 'healthcheck-out.log'),
      error_file: path.join(logDir, 'healthcheck-error.log'),
      time: true,
    },
  ],
};
