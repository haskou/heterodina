// Runs the API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'server/main.ts'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];

const stop = (): void => {
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', () => { stop(); process.exitCode = 1; });
