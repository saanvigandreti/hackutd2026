import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { z } from 'zod';
import { readBoundedJson } from './nemotron.ts';
import type { RegistryMetadata } from './types.ts';

const REGISTRY = 'https://registry.npmjs.org';
const packageName = z.string().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const isPackageName = (name: string) => packageName.safeParse(name).success;
const packageVersion = z.string().min(1).max(100).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const metadataSchema = z.object({
  name: z.string().max(214), version: z.string().max(100),
  description: z.string().max(10_000).optional(), deprecated: z.string().max(10_000).optional(),
});

export async function lookupPackage(name: string, version: string, options: {
  signal?: AbortSignal; fetchImpl?: typeof fetch;
} = {}): Promise<RegistryMetadata> {
  if (!packageName.safeParse(name).success || !packageVersion.safeParse(version).success) {
    throw new Error('Package lookup requires an npm package name and an exact semantic version.');
  }
  options.signal?.throwIfAborted();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const base = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  async function readVersion(requestedVersion: string) {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${base}/${encodeURIComponent(requestedVersion)}`, {
        method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' },
      });
    } catch {
      if (signal.aborted) throw new Error('npm lookup was cancelled or exceeded its time limit.');
      throw new Error('Could not reach the npm registry.');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) throw new Error('This package version was not found in the public npm registry.');
      throw new Error(`npm metadata lookup failed (HTTP ${response.status}).`);
    }
    let raw: unknown;
    try { raw = await readBoundedJson(response, 1_048_576); }
    catch { throw new Error('npm returned unreadable or oversized metadata.'); }
    const result = metadataSchema.safeParse(raw);
    if (!result.success || result.data.name !== name || !packageVersion.safeParse(result.data.version).success
        || (requestedVersion !== 'latest' && result.data.version !== requestedVersion)) {
      throw new Error('npm returned metadata that does not match the requested package version.');
    }
    return result.data;
  }
  const selected = await readVersion(version);
  const latest = await readVersion('latest');
  return {
    name: selected.name, version: selected.version, latest: latest.version,
    description: selected.description ?? '', publishedAt: null,
    deprecated: selected.deprecated ?? null, source: `${base}/${encodeURIComponent(version)}`,
  };
}

const MAX_PACKUMENT_BYTES = 48 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const dependencyMap = z.record(z.string().max(1000)).optional();
const versionSchema = z.object({
  version: z.string().max(100),
  dist: z.object({ tarball: z.string().max(2000), integrity: z.string().max(2000).optional() }),
  dependencies: dependencyMap, peerDependencies: dependencyMap,
});
const packumentSchema = z.object({
  name: z.string().max(214),
  'dist-tags': z.record(z.string().max(100)).default({}),
  versions: z.record(versionSchema),
});
export type Packument = z.infer<typeof packumentSchema>;

export interface RegistryOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Packuments already fetched during one preparation, keyed by package name. */
  packuments?: Map<string, Promise<Packument>>;
}

export interface PublishedDeclarations {
  name: string;
  version: string;
  /** The published package.json, parsed. */
  manifest: Record<string, unknown>;
  /** Every `.d.ts`, `.d.mts` and `.d.cts` file in the tarball, keyed by its path inside the package. */
  files: Record<string, string>;
  tarball: string;
  integrity: string;
}

async function readBoundedBytes(response: Response, maximumBytes: number, label: string): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`npm returned ${label} larger than ${maximumBytes / 1_048_576} MiB.`);
  }
  if (!response.body) throw new Error(`npm returned an empty ${label}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read().catch(() => { throw new Error(`npm stopped sending ${label}: the download was cancelled, timed out or dropped.`); });
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error(`npm returned ${label} larger than ${maximumBytes / 1_048_576} MiB.`);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function registryGet(url: string, options: RegistryOptions, accept: string, timeout: number, what: string): Promise<Response> {
  options.signal?.throwIfAborted();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  try {
    return await (options.fetchImpl ?? fetch)(url, { method: 'GET', redirect: 'error', signal, headers: { Accept: accept } });
  } catch {
    if (signal.aborted) throw new Error(`Downloading ${what} from npm was cancelled or exceeded its time limit.`);
    throw new Error(`Could not reach the npm registry for ${what}.`);
  }
}

export function fetchPackument(name: string, options: RegistryOptions = {}): Promise<Packument> {
  if (!packageName.safeParse(name).success) return Promise.reject(new Error(`"${name}" is not a valid npm package name.`));
  const cached = options.packuments?.get(name);
  if (cached) return cached;
  const pending = (async () => {
    const response = await registryGet(`${REGISTRY}/${encodeURIComponent(name)}`, options,
      'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8', 30_000, `the ${name} version list`);
    if (response.status === 404) { await response.body?.cancel(); throw new Error(`Package ${name} was not found in the public npm registry.`); }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`npm version lookup for ${name} failed (HTTP ${response.status}).`); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBytes(response, MAX_PACKUMENT_BYTES, `the ${name} version list`))); }
    catch (error) { throw new Error(error instanceof Error && /^npm (?:returned|stopped)/.test(error.message) ? error.message : `npm returned an unreadable version list for ${name}.`); }
    const parsed = packumentSchema.safeParse(raw);
    if (!parsed.success || parsed.data.name !== name) throw new Error(`npm returned a version list that does not match ${name}.`);
    return parsed.data;
  })();
  options.packuments?.set(name, pending);
  pending.catch(() => options.packuments?.delete(name));
  return pending;
}

type Parsed = [number, number, number, string];
function parseVersion(text: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : null;
}
function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split('.'), right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index], y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function compare(a: Parsed, b: Parsed): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || comparePrerelease(a[3], b[3]);
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error(`Cannot compare versions ${a} and ${b}.`);
  return compare(left, right);
}

type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; version: Parsed };
function partial(text: string): { parts: number[]; pre: string } | null {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  const parts: number[] = [];
  for (const part of match.slice(1, 4)) {
    if (part === undefined || /^[xX*]$/.test(part)) break;
    parts.push(Number(part));
  }
  return { parts, pre: parts.length === 3 ? match[4] ?? '' : '' };
}
function floor(parts: number[], pre = ''): Parsed { return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre]; }
function bump(parts: number[]): Parsed {
  if (parts.length === 1) return [(parts[0] ?? 0) + 1, 0, 0, ''];
  if (parts.length === 2) return [parts[0] ?? 0, (parts[1] ?? 0) + 1, 0, ''];
  return [parts[0] ?? 0, parts[1] ?? 0, (parts[2] ?? 0) + 1, ''];
}
function comparators(text: string): Comparator[] | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const low = partial(hyphen[1] ?? ''), high = partial(hyphen[2] ?? '');
    if (!low || !high) return null;
    const result: Comparator[] = [{ op: '>=', version: floor(low.parts, low.pre) }];
    if (high.parts.length === 3) result.push({ op: '<=', version: floor(high.parts, high.pre) });
    else if (high.parts.length > 0) result.push({ op: '<', version: bump(high.parts) });
    return result;
  }
  const result: Comparator[] = [];
  for (const token of text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=|\^|~>?)?(.*)$/.exec(token);
    const op = match?.[1] ?? '';
    const value = partial(match?.[2] ?? '');
    if (!value) return null;
    const { parts, pre } = value;
    const low = floor(parts, pre);
    if (op === '^') {
      result.push({ op: '>=', version: low });
      const index = parts.findIndex((part) => part !== 0);
      const keep = index === -1 ? Math.max(parts.length, 1) : index + 1;
      if (parts.length > 0) result.push({ op: '<', version: bump(parts.slice(0, Math.min(keep, parts.length))) });
    } else if (op.startsWith('~')) {
      result.push({ op: '>=', version: low });
      if (parts.length > 0) result.push({ op: '<', version: bump(parts.slice(0, parts.length === 1 ? 1 : 2)) });
    } else if (op === '' || op === '=') {
      if (parts.length === 3) result.push({ op: '=', version: low });
      else if (parts.length > 0) result.push({ op: '>=', version: low }, { op: '<', version: bump(parts) });
    } else if (parts.length === 3 || op === '>=' || op === '<') {
      result.push({ op: op as Comparator['op'], version: low });
    } else if (parts.length > 0) {
      result.push(op === '>' ? { op: '>=', version: bump(parts) } : { op: '<', version: bump(parts) });
    } else if (op === '<') return [{ op: '<', version: [0, 0, 0, ''] }];
  }
  return result;
}
function matches(version: Parsed, set: Comparator[]): boolean {
  if (version[3] && !set.some((item) => item.version[3] && item.version.slice(0, 3).join('.') === version.slice(0, 3).join('.'))) return false;
  return set.every(({ op, version: bound }) => {
    const order = compare(version, bound);
    return op === '=' ? order === 0 : op === '>=' ? order >= 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : order < 0;
  });
}

/** Highest version satisfying an npm range. Supports exact, `^`, `~`, x-ranges, comparators, `||` and hyphen ranges. */
export function maxSatisfying(versions: Iterable<string>, range: string): string | null {
  const sets = range.trim() === '' ? [[]] : range.split('||').map((part) => comparators(part.trim()));
  if (sets.some((set) => set === null)) return null;
  let best: [string, Parsed] | null = null;
  for (const text of versions) {
    const version = parseVersion(text);
    if (!version || !(sets as Comparator[][]).some((set) => matches(version, set))) continue;
    if (!best || compare(version, best[1]) > 0) best = [text, version];
  }
  return best?.[0] ?? null;
}

/** Resolves an exact version, a dist-tag such as `latest`, or an npm range to a published version. */
export async function resolvePublishedVersion(name: string, range: string, options: RegistryOptions = {}): Promise<string> {
  const packument = await fetchPackument(name, options);
  const wanted = range.trim();
  const tagged = packument['dist-tags'][wanted];
  if (tagged && Object.hasOwn(packument.versions, tagged)) return tagged;
  if (Object.hasOwn(packument.versions, wanted)) return wanted;
  if (/^(?:file|link|workspace|git(?:\+[a-z]+)?|https?|npm):/.test(wanted) || wanted.includes('/')) {
    throw new Error(`${name} is requested as "${wanted}", which is not a published npm version range.`);
  }
  if (/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(wanted)) throw new Error(`Version ${wanted} of ${name} was not found in the public npm registry.`);
  const best = maxSatisfying(Object.keys(packument.versions), wanted);
  if (!best) throw new Error(`No published version of ${name} matches "${wanted}".`);
  return best;
}

interface TarEntry { path: string; data: Buffer }
function octal(header: Buffer, offset: number, length: number): number {
  if ((header[offset] ?? 0) & 0x80) throw new Error('The package archive uses an unsupported size encoding.');
  const text = header.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('The package archive is corrupt (a tar header number is not octal).');
  return text ? Number.parseInt(text, 8) : 0;
}
function cString(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
}

/** Reads regular files from an uncompressed ustar archive, honoring pax `path` and GNU long names. */
export function readTar(archive: Buffer, keep: (path: string) => boolean): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0, longName: string | null = null, paxPath: string | null = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const sum = octal(header, 148, 8);
    let actual = 0;
    for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
    if (sum !== actual) throw new Error('The package archive is corrupt (bad tar header checksum).');
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (start + size > archive.length) throw new Error('The package archive is truncated.');
    const data = archive.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cString(data); continue; }
    if (type === 'x') {
      for (const match of data.toString('utf8').matchAll(/^\d+ path=(.*)$/gm)) paxPath = match[1] ?? null;
      continue;
    }
    if (type === 'g') continue;
    const prefix = header.subarray(257, 263).toString('latin1') === 'ustar\0' ? cString(header.subarray(345, 500)) : '';
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)));
    longName = null; paxPath = null;
    if (type !== '0' && type !== '\0') continue;
    const inside = name.split('/').slice(1).join('/');
    const normalized = path.posix.normalize(inside);
    if (!inside || normalized !== inside || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) continue;
    if (keep(normalized)) entries.push({ path: normalized, data: Buffer.from(data) });
  }
  return entries;
}

async function cachedTarball(file: string, digest: Buffer): Promise<Buffer | null> {
  try {
    const bytes = await readFile(file);
    return createHash('sha512').update(bytes).digest().equals(digest) ? bytes : null;
  } catch { return null; }
}

/**
 * Downloads one published version's tarball from registry.npmjs.org (or reuses a verified cached copy),
 * checks its sha512 integrity and returns its `.d.ts`, `.d.mts` and `.d.cts` files and package.json. Nothing in the package is run or unpacked to disk.
 */
export async function fetchDeclarations(name: string, version: string, options: RegistryOptions & { cacheDirectory: string }): Promise<PublishedDeclarations> {
  const packument = await fetchPackument(name, options);
  const published = Object.hasOwn(packument.versions, version) ? packument.versions[version] : undefined;
  if (!published) throw new Error(`Version ${version} of ${name} was not found in the public npm registry.`);
  const tarball = published.dist.tarball;
  let url: URL;
  try { url = new URL(tarball); } catch { throw new Error(`npm listed an invalid tarball address for ${name}@${version}.`); }
  if (url.protocol !== 'https:' || url.host !== 'registry.npmjs.org') throw new Error(`npm listed a tarball for ${name}@${version} outside registry.npmjs.org; Ketchup only downloads from the public registry.`);
  const integrity = published.dist.integrity?.split(/\s+/).find((item) => item.startsWith('sha512-'));
  const digest = integrity ? Buffer.from(integrity.slice(7), 'base64') : null;
  if (!integrity || digest?.length !== 64) throw new Error(`npm publishes no sha512 integrity for ${name}@${version}, so Ketchup will not use its tarball.`);
  const cacheFile = path.join(options.cacheDirectory, 'npm', `${digest.toString('hex')}.tgz`);
  let bytes = await cachedTarball(cacheFile, digest);
  if (!bytes) {
    const response = await registryGet(url.href, options, 'application/octet-stream', 60_000, `${name}@${version}`);
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Downloading ${name}@${version} from npm failed (HTTP ${response.status}).`); }
    bytes = Buffer.from(await readBoundedBytes(response, MAX_TARBALL_BYTES, `the ${name}@${version} tarball`));
    if (!createHash('sha512').update(bytes).digest().equals(digest)) {
      throw new Error(`The ${name}@${version} tarball failed its sha512 integrity check; it was not used.`);
    }
    const temporary = `${cacheFile}.${randomUUID()}.partial`;
    try {
      await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, cacheFile);
    } catch { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  let archive: Buffer;
  try { archive = await promisify(gunzip)(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch { throw new Error(`The ${name}@${version} tarball could not be decompressed or exceeds ${MAX_UNPACKED_BYTES / 1_048_576} MiB unpacked.`); }
  const entries = readTar(archive, (file) => file === 'package.json' || /\.d\.[cm]?ts$/.test(file));
  let manifest: Record<string, unknown> = {};
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.path === 'package.json') {
      try { manifest = z.record(z.unknown()).parse(JSON.parse(entry.data.toString('utf8'))); }
      catch { throw new Error(`The package.json inside ${name}@${version} is not valid JSON.`); }
    } else files[entry.path] = entry.data.toString('utf8');
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`${name}@${version} publishes no TypeScript declaration files (.d.ts, .d.mts or .d.cts). Ketchup does not look up DefinitelyTyped @types packages.`);
  }
  return { name, version, manifest, files, tarball: url.href, integrity };
}
