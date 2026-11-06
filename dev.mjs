import { spawn } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

// Auto-load root .env if present
try {
  if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
    process.loadEnvFile('.env');
  }
} catch {}

const defaultBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:5173';

console.log('====================================================');
console.log(' Starting Aventas Pay Development Environment');
console.log(' - Website Backend API:  http://127.0.0.1:4000');
console.log(' - Frontend Vite Server: http://localhost:5173');
console.log(` - Public Base URL:      ${defaultBaseUrl}`);
console.log('====================================================');

const backend = spawn(npmCmd, ['start'], {
  cwd: 'website',
  stdio: 'inherit',
  shell: isWin,
  env: {
    ...process.env,
    PUBLIC_BASE_URL: defaultBaseUrl,
  },
});

const frontend = spawn(npmCmd, ['run', 'dev'], {
  cwd: 'frontend',
  stdio: 'inherit',
  shell: isWin,
  env: {
    ...process.env,
    PORT: '5173',
    VITE_PORT: '5173',
    PUBLIC_BASE_URL: defaultBaseUrl,
  },
});

function cleanup() {
  try { backend.kill(); } catch {}
  try { frontend.kill(); } catch {}
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
