import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

test('the documented entrypoint starts outside its directory, finds a free local port and shuts down', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup startup '));
  const occupied = createServer((_request, response) => response.end('occupied'));
  // Parallel protocol fixtures use ephemeral ports; reserve a lower port for this test.
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(20_000 + process.pid % 10_000, '127.0.0.1', resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    cwd: directory,
    env: { ...process.env, NVIDIA_API_KEY: '', KETCHUP_PORT: String(port), KETCHUP_DATA_DIR: path.join(directory, 'saved work') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  let ready = '';
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The documented entrypoint did not become ready within ten seconds.')), 10_000);
      let output = '';
      let errorOutput = '';
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stderr.on('data', (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(-4_096); });
      child.once('close', (code) => { clearTimeout(timer); reject(new Error(`The entrypoint exited before readiness (code ${code}): ${errorOutput}`)); });
      child.stdout.on('data', (data: Buffer) => {
        output = (output + data.toString()).slice(-4_096);
        const match = /http:\/\/127\.0\.0\.1:\d+(?=\s)/.exec(output);
        if (match) { clearTimeout(timer); ready = output; resolve(match[0]); }
      });
    });
    assert.ok([port + 1, port + 2].includes(Number(new URL(base).port)));
    assert.match(ready, /The reference repair is ready\. Add NVIDIA_API_KEY to \.env and restart for live drafting\./);
    const status = z.object({ name: z.literal('Ketchup'), keyConfigured: z.literal(false) }).parse(await (await fetch(`${base}/api/status`)).json());
    assert.equal(status.name, 'Ketchup');
    assert.match(await (await fetch(base)).text(), /<title>Ketchup[^<]*<\/title>/);
    assert.equal((await fetch(`${base}/favicon.svg`)).headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    child.kill('SIGTERM');
    assert.equal(await closed, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
