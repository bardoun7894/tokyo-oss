// pm2 config. Copy, adjust paths, then: pm2 start ecosystem.config.example.js
module.exports = {
  apps: [{
    name: "tokyo",
    script: "node_modules/tsx/dist/cli.mjs",
    args: "src/index.ts",
    cwd: __dirname,
    env: {
      NODE_ENV: "production",
      NODE_OPTIONS: "--dns-result-order=ipv4first",
    },
    restart_delay: 5000,
    max_restarts: 10,
    autorestart: true,
    watch: false,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file: "logs/output.log",
    merge_logs: true,
  }],
};
