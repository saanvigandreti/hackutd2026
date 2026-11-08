import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchDeclarations, lookupPackage, maxSatisfying, readTar, resolvePublishedVersion } from '../src/registry.ts';
import { stubRegistry, tar } from './fixtures/intake/stub.ts';

const cache = (t: test.TestContext) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ketchup-registry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('resolves the npm range subset Ketchup needs', () => {
  const versions = ['0.0.3', '0.0.4', '0.2.3', '0.2.9', '0.3.0', '1.0.0', '1.2.0', '1.2.7', '1.3.0', '2.0.0-rc.1', '2.0.0', '2.4.1', '3.0.0-beta.2'];
  const cases: [string, string | null][] = [
    ['1.2.0', '1.2.0'], ['=1.2.0', '1.2.0'], ['v1.2.0', '1.2.0'], ['^1.0.0', '1.3.0'], ['^0.2.3', '0.2.9'], ['^0.0.3', '0.0.3'],
    ['~1.2.0', '1.2.7'], ['~1', '1.3.0'], ['1.x', '1.3.0'], ['1.2.x', '1.2.7'], ['1', '1.3.0'], ['*', '2.4.1'], ['', '2.4.1'],
    ['>=1.2.1', '2.4.1'], ['>=1.0.0 <2.0.0', '1.3.0'], ['>= 1.0.0 < 1.2.5', '1.2.0'], ['>1.2', '2.4.1'], ['<=1.2', '1.2.7'], ['<1.2', '1.0.0'],
    ['^0.0.3 || ^1.0.0', '1.3.0'], ['1.0.0 - 1.2.0', '1.2.0'], ['1.0.0 - 1.2', '1.2.7'], ['^2.0.0-rc.1', '2.4.1'], ['2.0.0-rc.1', '2.0.0-rc.1'],
    ['^3.0.0', null], ['^9', null], ['latest', null],
  ];
  for (const [range, expected] of cases) assert.equal(maxSatisfying(versions, range), expected, range);
});

test('reads ustar entries with pax long names and ignores non-declarations', () => {
  const long = `deep/${'nested/'.repeat(20)}types.d.ts`;
  const entries = readTar(tar({ 'package.json': '{}', 'index.d.ts': 'a', [long]: 'b', 'index.js': 'c' }), (file) => file.endsWith('.d.ts'));
  assert.deepEqual(entries.map((entry) => [entry.path, entry.data.toString()]), [['index.d.ts', 'a'], [long, 'b']]);
  assert.deepEqual(readTar(tar({ '../escape.d.ts': 'x' }), () => true), []);
  const corrupt = tar({ 'index.d.ts': 'a' });
  corrupt[0] = 0x7a;
  assert.throws(() => readTar(corrupt, () => true), /checksum/);
});

test('rejects a tar header whose size is not octal instead of looping on it', () => {
  const archive = tar({ 'index.d.ts': 'a' });
  // A size of -1000 octal would move the reader back one block forever; the checksum is recomputed so only the size is wrong.
  archive.write('-1000\0'.padEnd(12, '\0'), 124, 12, 'latin1');
  archive.fill(0x20, 148, 156);
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += archive[index] ?? 0;
  archive.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  assert.throws(() => readTar(archive, () => true), /not octal/);
});

test('downloads, verifies and caches published declarations', async (t) => {
  const registry = stubRegistry();
  const cacheDirectory = cache(t);
  const result = await fetchDeclarations('@ketchup-fixture/meter', '2.0.0', { cacheDirectory, fetchImpl: registry.fetchImpl });
  assert.deepEqual(readdirSync(cacheDirectory), ['npm'], 'tarballs are cached under <cache>/npm/');
  assert.match(readdirSync(path.join(cacheDirectory, 'npm')).join(','), /^[0-9a-f]{128}\.tgz$/);
  assert.deepEqual(Object.keys(result.files).sort(), ['build/index.d.ts', 'build/meter.d.ts']);
  assert.equal(result.manifest.name, '@ketchup-fixture/meter');
  assert.match(result.integrity, /^sha512-/);
  assert.equal(result.tarball, 'https://registry.npmjs.org/@ketchup-fixture/meter/-/meter-2.0.0.tgz');
  const modules = stubRegistry(undefined, { '@ketchup-fixture/modules': { '1.0.0': { 'package.json': '{}', 'index.d.mts': 'export {};\n', 'index.d.cts': 'export {};\n', 'index.mjs': '' } } });
  const split = await fetchDeclarations('@ketchup-fixture/modules', '1.0.0', { cacheDirectory: cache(t), fetchImpl: modules.fetchImpl });
  assert.deepEqual(Object.keys(split.files).sort(), ['index.d.cts', 'index.d.mts'], 'packages that publish only .d.mts or .d.cts declarations are read');
});

test('reports registry failures plainly', async (t) => {
  const cacheDirectory = cache(t);
  const registry = stubRegistry(undefined, { 'host-swap': { '1.0.0': { 'index.d.ts': 'export {};' } } });
  const options = { cacheDirectory, fetchImpl: registry.fetchImpl };
  await assert.rejects(fetchDeclarations('not-published-anywhere', '1.0.0', options), /Package not-published-anywhere was not found/);
  await assert.rejects(fetchDeclarations('@ketchup-fixture/meter', '5.0.0', options), /Version 5\.0\.0 of @ketchup-fixture\/meter was not found/);
  await assert.rejects(fetchDeclarations('@ketchup-fixture/untyped', '1.0.0', options), /publishes no TypeScript declaration files/);
  registry.tamper('@ketchup-fixture/base', '4.0.0');
  await assert.rejects(fetchDeclarations('@ketchup-fixture/base', '4.0.0', options), /integrity check/);
  await assert.rejects(fetchDeclarations('Bad Name', '1.0.0', options), /not a valid npm package name/);
  await assert.rejects(fetchDeclarations('@ketchup-fixture/meter', 'toString', options), /Version toString of @ketchup-fixture\/meter was not found/);
  assert.equal(await resolvePublishedVersion('@ketchup-fixture/base', 'latest', options), '4.0.0');
  await assert.rejects(resolvePublishedVersion('@ketchup-fixture/base', 'file:../base', options), /not a published npm version range/);

  const offHost = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/elsewhere')) {
      return new Response(JSON.stringify({ name: 'elsewhere', 'dist-tags': {}, versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://example.com/elsewhere-1.0.0.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } } } }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  await assert.rejects(fetchDeclarations('elsewhere', '1.0.0', { cacheDirectory, fetchImpl: offHost }), /outside registry\.npmjs\.org/);

  const oversized = (async () => new Response('{}', { status: 200, headers: { 'content-length': String(100 * 1_048_576) } })) as typeof fetch;
  await assert.rejects(fetchDeclarations('big', '1.0.0', { cacheDirectory, fetchImpl: oversized }), /larger than 48 MiB/);
  const stalled = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith('.tgz')) return registry.fetchImpl(input, init);
    return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason)); } }), { status: 200 });
  }) as typeof fetch;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(fetchDeclarations('@ketchup-fixture/base', '2.0.0', { cacheDirectory, fetchImpl: stalled, signal: controller.signal }), /npm stopped sending the @ketchup-fixture\/base@2\.0\.0 tarball/);
  const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(fetchDeclarations('left-pad', '1.0.0', { cacheDirectory, fetchImpl: offline }), /Could not reach the npm registry/);
});

test('keeps the agent lookup tool unchanged', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const latest = String(input).endsWith('/latest');
    return new Response(JSON.stringify({ name: 'label-kit', version: latest ? '2.1.0' : '2.0.0', description: 'Labels' }), { status: 200 });
  }) as typeof fetch;
  const result = await lookupPackage('label-kit', '2.0.0', { fetchImpl });
  assert.deepEqual(result, { name: 'label-kit', version: '2.0.0', latest: '2.1.0', description: 'Labels', publishedAt: null, deprecated: null, source: 'https://registry.npmjs.org/label-kit/2.0.0' });
});
