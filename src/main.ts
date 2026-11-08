import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.ts';

const requestedPort = Number(process.env['KETCHUP_PORT'] ?? 4317);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65533) {
  process.stderr.write('KETCHUP_PORT must be an integer between 1024 and 65533.\n');
  process.exitCode = 1;
} else {
  const dataDirectory = process.env['KETCHUP_DATA_DIR'] ?? fileURLToPath(new URL('../.ketchup/workspaces/', import.meta.url));
  try {
    const app = await createApp({ dataDirectory, ...(process.env['NVIDIA_API_KEY'] ? { apiKey: process.env['NVIDIA_API_KEY'] } : {}) });
    let port = requestedPort;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          app.server.once('error', reject);
          app.server.listen(port, '127.0.0.1', () => { app.server.removeListener('error', reject); resolve(); });
        });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE' || attempt === 2) throw error;
        port++;
      }
    }
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(`\n  Ketchup is ready at ${url}\n  ${process.env['NVIDIA_API_KEY'] ? 'NVIDIA key loaded from the environment.' : 'The reference repair is ready. Add NVIDIA_API_KEY to .env and restart for live drafting.'}\n  Press Ctrl+C to stop.\n\n`);
    if (process.argv.includes('--open')) {
      if (process.platform === 'darwin') execFile('open', [url], () => {});
      else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
      else execFile('xdg-open', [url], () => {});
    }
    const stop = () => { void app.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'STARTUP_ERROR';
    process.stderr.write(`Ketchup could not start (${code}). Check the port, data-folder permissions, and installed dependencies.\n`);
    process.exitCode = 1;
  }
}
