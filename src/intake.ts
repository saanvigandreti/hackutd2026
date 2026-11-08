import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { packageNameFor, readImportReferences } from './imports.ts';
import { z } from 'zod';
import { fetchDeclarations, fetchPackument, isPackageName, resolvePublishedVersion, type RegistryOptions } from './registry.ts';
import type { MigrationBundle, PackageTypes, Snapshot } from './types.ts';

const MiB = 1_048_576;
export const INTAKE_LIMITS = { files: 4000, fileBytes: MiB, totalBytes: 16 * MiB };
const SKIPPED_FOLDERS = new Map([
  ['node_modules', 'installed packages; only the selected dependency\'s declarations are read'],
  ['dist', 'build output'], ['build', 'build output'], ['coverage', 'test coverage output'],
]);
const MAX_SCANNED_ENTRIES = 100_000;
const MAX_OMITTED = 300;
const MAX_NOTE = 1000;
/** Bytes counted per file for its JSON key and separators, and bytes kept free for the rest of the bundle. */
const FILE_OVERHEAD = 256;
const RESERVED_BYTES = MiB;
const MAX_TYPE_PACKAGES = 80;
const TYPE_DEPTH = 6;

const dependencyRanges = z.record(z.string()).optional().catch(undefined);
const projectManifest = z.object({
  description: z.string().optional().catch(undefined),
  dependencies: dependencyRanges, devDependencies: dependencyRanges,
  peerDependencies: dependencyRanges, optionalDependencies: dependencyRanges,
  ketchup: z.object({ intent: z.string().optional().catch(undefined) }).optional().catch(undefined),
});
type Manifest = Record<string, unknown>;

export interface ProjectDependency {
  name: string;
  range: string;
  installed: string | null;
  /** Whether the project's sources import this package. */
  imported: boolean;
  /** Declared only in devDependencies. */
  dev: boolean;
  /** The registry's `latest` dist-tag, or null when npm could not be reached. */
  latest: string | null;
}
export interface ProjectInspection { folder: string; dependencies: ProjectDependency[]; sourceCount: number }
export interface PrepareOptions {
  root: string;
  dependency: string;
  targetVersion: string;
  cacheDirectory: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Paths the analysis engine accepts: plain segments, no traversal, secrets, .git or node_modules. */
function acceptedPath(name: string): boolean {
  return name.length <= 400 && name.split('/').every((part) => /^[a-zA-Z0-9_@.-]+$/.test(part)
    && part !== '.' && part !== '..' && !part.startsWith('.env') && part !== '.git' && part !== 'node_modules');
}
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const byteSize = (text: string) => Buffer.byteLength(JSON.stringify(text));
const DECLARATION = /\.d\.[cm]?ts$/;
export { isBuiltin as isNodeBuiltin } from 'node:module';

/** The engine rejects two paths in one file group that differ only in letter case, so the second one is left out. */
class CaseGuard {
  private seen = new Map<string, string>();
  private omitted: Omissions;
  constructor(omitted: Omissions) { this.omitted = omitted; }
  admit(label: string, name: string): boolean {
    const key = name.toLowerCase();
    const first = this.seen.get(key);
    if (first !== undefined) { this.omitted.add(`${label}: differs from ${first} only in letter case`); return false; }
    this.seen.set(key, name);
    return true;
  }
}

async function readJson(file: string, label: string): Promise<unknown> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label} was not found.`);
  if (info.size > MiB) throw new Error(`${label} is larger than 1 MiB.`);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`${label} is not valid JSON.`); }
}

async function openProject(root: string) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Give the absolute path of a project folder.');
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error('The project path is not a folder.');
  const realRoot = await realpath(root);
  const raw = await readJson(path.join(realRoot, 'package.json'), 'The project\'s package.json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The project\'s package.json must contain an object.');
  const manifest = projectManifest.parse(raw);
  const ranges = new Map<string, string>();
  for (const group of [manifest.peerDependencies, manifest.optionalDependencies, manifest.devDependencies, manifest.dependencies]) {
    for (const [name, range] of Object.entries(group ?? {})) ranges.set(name, range);
  }
  return { realRoot, folder: path.basename(realRoot), manifest, ranges };
}

interface LocalPackage { dir: string; version: string; manifest: Manifest }
async function installedPackage(realRoot: string, name: string, from = realRoot): Promise<LocalPackage | null> {
  for (let directory = from; inside(realRoot, directory); directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'));
    const dir = await realpath(candidate).catch(() => null);
    if (dir && inside(realRoot, dir)) {
      const raw = await readJson(path.join(dir, 'package.json'), `${name}'s installed package.json`).catch(() => null);
      const manifest = z.record(z.unknown()).safeParse(raw);
      const version = manifest.success ? manifest.data.version : undefined;
      if (manifest.success && typeof version === 'string') return { dir, version, manifest: manifest.data };
    }
    if (directory === realRoot) break;
  }
  return null;
}

class Omissions {
  readonly items: string[] = [];
  private extra = 0;
  add(item: string) { if (this.items.length < MAX_OMITTED) this.items.push(item.length > MAX_NOTE ? `${item.slice(0, MAX_NOTE - 1)}…` : item); else this.extra++; }
  list() { return this.extra ? [...this.items, `${this.extra} more omitted items are not listed`] : this.items; }
}

async function scanSources(realRoot: string, omitted: Omissions, signal?: AbortSignal) {
  const found: { name: string; file: string }[] = [];
  let scanned = 0;
  async function visit(relative: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await readdir(path.join(realRoot, relative), { withFileTypes: true }).catch(() => null);
    if (!entries) { omitted.add(`${relative || '.'}/: folder could not be read`); return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_ENTRIES) {
        if (scanned === MAX_SCANNED_ENTRIES + 1) omitted.add(`Scanning stopped after ${MAX_SCANNED_ENTRIES.toLocaleString('en-US')} entries; later files were not read`);
        return;
      }
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      let full = path.join(realRoot, name);
      let directory = entry.isDirectory(), file = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => null);
        if (!target) { if (/\.tsx?$/.test(entry.name)) omitted.add(`${name}: broken symbolic link`); continue; }
        if (!inside(realRoot, target)) { omitted.add(`${name}: symbolic link points outside the project`); continue; }
        const info = await stat(target);
        if (info.isDirectory()) { omitted.add(`${name}/: symbolic link to a folder inside the project; not followed`); continue; }
        full = target; directory = false; file = info.isFile();
      }
      if (directory) {
        const reason = entry.name.startsWith('.') ? 'hidden folder' : SKIPPED_FOLDERS.get(entry.name);
        if (reason) omitted.add(`${name}/: ${reason}`);
        else await visit(name);
      } else if (file) {
        if (entry.name.startsWith('.env')) omitted.add(`${name}: environment file, never read`);
        else if (entry.name.endsWith('.d.ts')) omitted.add(`${name}: project declaration file, not analyzed as a source`);
        else if (/\.(?:tsx|mts|cts)$/.test(entry.name)) omitted.add(`${name}: only .ts sources are analyzed`);
        else if (entry.name.endsWith('.ts')) {
          if (acceptedPath(name)) found.push({ name, file: full });
          else omitted.add(`${name}: the path has characters or segments Ketchup does not accept`);
        }
      }
    }
  }
  await visit('');
  return found;
}

/** Lists the project's dependencies: packages its sources import that it needs at runtime first, then the rest, then @types packages. */
export async function inspectProject(root: string, options: { fetchImpl?: typeof fetch } = {}): Promise<ProjectInspection> {
  const project = await openProject(root);
  const sources = await scanSources(project.realRoot, new Omissions());
  const specifiers = new Set<string>();
  for (const source of sources) {
    const info = await stat(source.file).catch(() => null);
    if (!info || info.size > INTAKE_LIMITS.fileBytes) continue;
    const text = await readFile(source.file, 'utf8').catch(() => '');
    for (const specifier of readImportReferences(text, source.name).modules) specifiers.add(specifier);
  }
  const imports = (name: string) => [...specifiers].some((specifier) => specifier === name || specifier.startsWith(`${name}/`));
  const latest = async (name: string) => {
    if (!isPackageName(name)) return null;
    try { return (await fetchPackument(name, { signal: AbortSignal.timeout(5_000), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }))['dist-tags']['latest'] ?? null; }
    catch { return null; }
  };
  const dependencies = await Promise.all([...project.ranges].map(async ([name, range]): Promise<ProjectDependency> => ({
    name, range, installed: (await installedPackage(project.realRoot, name))?.version ?? null,
    imported: imports(name), dev: project.manifest.devDependencies?.[name] !== undefined && project.manifest.dependencies?.[name] === undefined,
    latest: await latest(name),
  })));
  const rank = (item: ProjectDependency) => item.name.startsWith('@types/') ? 2 : item.imported && !item.dev ? 0 : 1;
  dependencies.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1));
  return { folder: project.folder, dependencies, sourceCount: sources.length };
}

class Budget {
  files = 0;
  bytes = 0;
  readonly omitted: Omissions;
  constructor(omitted: Omissions) { this.omitted = omitted; }
  take(label: string, text: string): boolean {
    const size = byteSize(text) + FILE_OVERHEAD;
    if (Buffer.byteLength(text) > INTAKE_LIMITS.fileBytes) { this.omitted.add(`${label}: larger than 1 MiB`); return false; }
    if (this.files + 1 > INTAKE_LIMITS.files) { this.omitted.add(`${label}: over the ${INTAKE_LIMITS.files}-file limit`); return false; }
    if (this.bytes + size > INTAKE_LIMITS.totalBytes - RESERVED_BYTES) { this.omitted.add(`${label}: over the 16 MiB total limit`); return false; }
    this.files++; this.bytes += size;
    return true;
  }
}

interface Package {
  name: string;
  version: string;
  manifest: Manifest;
  /** Real folder for an installed package; absent for a registry tarball. */
  dir?: string;
  read(file: string): Promise<string | null>;
}

function localPackage(name: string, local: LocalPackage): Package {
  const cache = new Map<string, Promise<string | null>>();
  return {
    name, version: local.version, manifest: local.manifest, dir: local.dir,
    read(file) {
      let pending = cache.get(file);
      if (!pending) {
        pending = (async () => {
          const target = await realpath(path.join(local.dir, file)).catch(() => null);
          if (!target || !inside(local.dir, target) || !(await lstat(target)).isFile()) return null;
          return readFile(target, 'utf8');
        })();
        cache.set(file, pending);
      }
      return pending;
    },
  };
}

async function publishedPackage(name: string, version: string, options: RegistryOptions & { cacheDirectory: string }): Promise<Package> {
  const published = await fetchDeclarations(name, version, options);
  return { name, version, manifest: published.manifest, read: async (file) => published.files[file] ?? null };
}

const clean = (target: string) => path.posix.normalize(target.replace(/^\.\//, ''));
/** Conditions TypeScript matches under the engine's bundler resolution; other conditions are only fallbacks. */
const BUNDLER_CONDITIONS = new Set(['types', 'import', 'default']);
function typesTargets(node: unknown): string[] {
  if (typeof node === 'string') return DECLARATION.test(node) ? [clean(node)] : [];
  if (Array.isArray(node)) return node.flatMap(typesTargets);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  return [...(keys.includes('types') ? ['types'] : []), ...keys.filter((key) => key !== 'types' && BUNDLER_CONDITIONS.has(key)),
    ...keys.filter((key) => !BUNDLER_CONDITIONS.has(key))].flatMap((key) => typesTargets(record[key]));
}
function exportsFor(manifest: Manifest, subpath: string): unknown {
  const exports = manifest.exports;
  if (exports === undefined || exports === null) return undefined;
  const isMap = typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
  if (!isMap) return subpath === '.' ? exports : undefined;
  return (exports as Record<string, unknown>)[subpath];
}
async function firstExisting(pkg: Package, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate.startsWith('..') || !DECLARATION.test(candidate)) continue;
    if ((await pkg.read(candidate)) !== null) return candidate;
  }
  return null;
}
/** Declaration files a specifier can name: `x.js`/`x.ts` → `x.d.ts`, `x.mjs`/`x.mts` → `x.d.mts`, `x.cjs`/`x.cts` → `x.d.cts`. */
function withoutExtension(target: string): string[] {
  if (DECLARATION.test(target)) return [target];
  const match = /^(.*)\.([cm]?)(?:js|ts)$/.exec(target);
  return match ? [`${match[1]}.d.${match[2]}ts`] : [`${target}.d.ts`, `${target}/index.d.ts`];
}
async function entryFor(pkg: Package, subpath = ''): Promise<string | null> {
  const manifest = pkg.manifest;
  if (subpath) {
    const key = `.${subpath}`;
    return firstExisting(pkg, [...typesTargets(exportsFor(manifest, key)), ...withoutExtension(clean(subpath.slice(1)))]);
  }
  const named = [manifest.types, manifest.typings].filter((item): item is string => typeof item === 'string').map(clean);
  const main = typeof manifest.main === 'string' ? [...withoutExtension(clean(manifest.main)), clean(manifest.main).replace(/\.[cm]?js$/, '.d.ts')] : [];
  return firstExisting(pkg, [...typesTargets(exportsFor(manifest, '.')), ...named.flatMap(withoutExtension), ...main, 'index.d.ts']);
}

interface Collected { entry: string; files: Map<string, string>; imports: Map<string, Set<string>> }
/** Every declaration file reachable from the entries by relative imports, plus the bare packages they import. */
async function collect(pkg: Package, entries: string[], omitted: Omissions): Promise<Collected> {
  const files = new Map<string, string>();
  const imports = new Map<string, Set<string>>();
  const queue = [...entries];
  let nodeTypes = false;
  while (queue.length > 0 && files.size < INTAKE_LIMITS.files) {
    const file = queue.shift() ?? '';
    if (files.has(file)) continue;
    const text = await pkg.read(file);
    if (text === null) continue;
    if (!acceptedPath(file)) { omitted.add(`${pkg.name}@${pkg.version} ${file}: path Ketchup does not accept`); continue; }
    files.set(file, text);
    const relative = (specifier: string) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (target === '.') queue.push('index.d.ts');
      else if (!target.startsWith('..')) queue.push(...withoutExtension(target));
    };
    const references = readImportReferences(text, file);
    if (references.types.includes('node')) nodeTypes = true;
    for (const specifier of [...references.modules, ...references.types.filter((name) => name !== 'node')]) {
      if (specifier.startsWith('.')) { relative(specifier); continue; }
      if (isBuiltin(specifier)) { nodeTypes = true; continue; }
      const name = packageNameFor(specifier);
      if (!name) {
        if (!specifier.startsWith('/') && !specifier.startsWith('\\') && !specifier.startsWith('#')
            && !/^[a-z][a-z\d+.-]*:/i.test(specifier)) {
          omitted.add(`${specifier} (imported by ${pkg.name}@${pkg.version} declarations): not a valid npm package name, so it is not analyzed`);
        }
        continue;
      }
      if (name === pkg.name) continue;
      const set = imports.get(name) ?? new Set<string>();
      set.add(specifier.slice(name.length));
      imports.set(name, set);
    }
    for (const reference of references.paths) relative(reference.startsWith('.') ? reference : `./${reference}`);
  }
  if (nodeTypes) omitted.add(`${pkg.name}@${pkg.version}: its declarations use Node.js built-in modules; @types/node is not included, so those types stay unresolved`);
  if (files.size >= INTAKE_LIMITS.files && queue.length > 0) omitted.add(`${pkg.name}@${pkg.version}: more than ${INTAKE_LIMITS.files} declaration files are reachable; the rest were not read`);
  return { entry: entries[0] ?? '', files, imports };
}

async function admit(pkg: Package, collected: Collected, budget: Budget): Promise<PackageTypes | null> {
  const files: Record<string, string> = {};
  const ordered = [collected.entry, ...[...collected.files.keys()].filter((name) => name !== collected.entry).sort()];
  const cases = new CaseGuard(budget.omitted);
  for (const name of ordered) {
    const text = collected.files.get(name);
    const label = `${pkg.name}@${pkg.version} ${name}`;
    if (text !== undefined && cases.admit(label, name) && budget.take(label, text)) files[name] = text;
  }
  return Object.hasOwn(files, collected.entry) ? { version: pkg.version, entry: collected.entry, files } : null;
}

/**
 * The engine mounts each package with only its entry as `types`, so a subpath import resolves only to the declaration file at
 * the import path itself (`sub.d.ts`, `sub/index.d.ts`, or the extension it names). An `exports` target elsewhere stays unresolved.
 */
function noteUnresolvable(pkg: Package, subpath: string, found: string, omitted: Omissions) {
  const sub = clean(subpath.slice(1));
  if (withoutExtension(sub).includes(found)) return;
  omitted.add(`${pkg.name}${subpath}: ${pkg.name}@${pkg.version} publishes these declarations as ${found}, which the analysis cannot resolve from the import path, so imports of ${pkg.name}${subpath} stay unresolved`);
}

interface Side { label: string; pkg: Package; collected: Collected; types: Map<string, { pkg: Package; collected: Collected }>; fromRegistry: number; fromDisk: number }

async function prepareSide(pkg: Package, label: string, realRoot: string, options: RegistryOptions & { cacheDirectory: string }, omitted: Omissions, subpaths: string[]): Promise<Side> {
  const entry = await entryFor(pkg);
  if (!entry) throw new Error(`${pkg.name}@${pkg.version} has no TypeScript declaration entry (types, typings, exports types or index.d.ts).`);
  const entries = [entry];
  for (const subpath of subpaths) {
    const found = await entryFor(pkg, subpath);
    if (found) { entries.push(found); noteUnresolvable(pkg, subpath, found, omitted); }
    else omitted.add(`${pkg.name}${subpath}: imported by the project, but no declaration file was found in ${pkg.name}@${pkg.version}`);
  }
  const collected = await collect(pkg, entries, omitted);
  const side: Side = { label, pkg, collected, types: new Map(), fromRegistry: 0, fromDisk: 0 };
  const seen = new Set([pkg.name]);
  let level: { requester: Package; imports: Map<string, Set<string>> }[] = [{ requester: pkg, imports: collected.imports }];
  for (let depth = 0; depth < TYPE_DEPTH && level.length > 0; depth++) {
    const next: typeof level = [];
    for (const { requester, imports } of level) {
      for (const [name, subpaths] of [...imports].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (seen.has(name)) continue;
        seen.add(name);
        const owner = `${name} (imported by ${requester.name}@${requester.version} declarations, ${label})`;
        if (side.types.size >= MAX_TYPE_PACKAGES) { omitted.add(`${owner}: over the ${MAX_TYPE_PACKAGES}-package type dependency limit`); continue; }
        if (!isPackageName(name)) { omitted.add(`${owner}: not a valid npm package name, so it is not analyzed`); continue; }
        try {
          options.signal?.throwIfAborted();
          const local = requester.dir ? await installedPackage(realRoot, name, requester.dir) : null;
          let dependency: Package;
          if (local) { dependency = localPackage(name, local); side.fromDisk++; }
          else {
            const ranges = [requester.manifest.dependencies, requester.manifest.peerDependencies]
              .map((group) => (group && typeof group === 'object' ? (group as Record<string, unknown>)[name] : undefined));
            const range = ranges.find((item): item is string => typeof item === 'string');
            if (range === undefined) { omitted.add(`${owner}: not declared in ${requester.name}'s dependencies${requester.dir ? ' and not installed' : ''}`); continue; }
            dependency = await publishedPackage(name, await resolvePublishedVersion(name, range, options), options);
            side.fromRegistry++;
          }
          const entries: string[] = [];
          for (const subpath of ['', ...[...subpaths].filter(Boolean).sort()]) {
            const found = await entryFor(dependency, subpath);
            if (found) { entries.push(found); if (subpath) noteUnresolvable(dependency, subpath, found, omitted); }
            else if (subpath) omitted.add(`${name}${subpath}: no declaration file found in ${name}@${dependency.version}`);
          }
          if (entries.length === 0) { omitted.add(`${owner}: ${name}@${dependency.version} has no declaration entry`); continue; }
          const found = await collect(dependency, entries, omitted);
          side.types.set(name, { pkg: dependency, collected: found });
          next.push({ requester: dependency, imports: found.imports });
        } catch (error) {
          if (options.signal?.aborted) throw error;
          omitted.add(`${owner}: ${(error instanceof Error ? error.message : String(error)).split(realRoot).join(path.basename(realRoot))}`);
        }
      }
    }
    level = next;
  }
  if (level.length > 0) omitted.add(`${label}: type dependencies deeper than ${TYPE_DEPTH} levels were not followed`);
  return side;
}

async function snapshotOf(side: Side, budget: Budget): Promise<Snapshot> {
  const main = await admit(side.pkg, side.collected, budget);
  if (!main) throw new Error(`${side.pkg.name}@${side.pkg.version}'s declaration entry does not fit the analysis limits.`);
  return main;
}
async function addTypeDependencies(snapshot: Snapshot, side: Side, budget: Budget, omitted: Omissions) {
  const result: Record<string, PackageTypes> = {};
  for (const [name, { pkg, collected }] of side.types) {
    const admitted = await admit(pkg, collected, budget);
    if (admitted) result[name] = admitted;
    else omitted.add(`${name}@${pkg.version} (${side.label} type dependency): entry declaration does not fit the analysis limits`);
  }
  if (Object.keys(result).length > 0) snapshot.typeDependencies = result;
}

async function lockedVersion(realRoot: string, name: string): Promise<string | null> {
  const lock = await readJson(path.join(realRoot, 'package-lock.json'), 'package-lock.json').catch(() => null);
  const parsed = z.object({
    packages: z.record(z.object({ version: z.string().optional() }).passthrough()).optional(),
    dependencies: z.record(z.object({ version: z.string().optional() }).passthrough()).optional(),
  }).safeParse(lock);
  if (!parsed.success) return null;
  const version = parsed.data.packages?.[`node_modules/${name}`]?.version ?? parsed.data.dependencies?.[name]?.version;
  return version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version) ? version : null;
}

/** Builds a MigrationBundle from a local TypeScript project, its installed dependency and the published target version. */
export async function prepareProject(options: PrepareOptions): Promise<MigrationBundle> {
  const project = await openProject(options.root);
  const { realRoot, folder, manifest } = project;
  const name = options.dependency;
  if (typeof name !== 'string' || !isPackageName(name)) throw new Error('Choose a dependency by its npm package name.');
  const omitted = new Omissions();
  const registry = { fetchImpl: options.fetchImpl, signal: options.signal, packuments: new Map(), cacheDirectory: options.cacheDirectory };
  const installed = await installedPackage(realRoot, name);
  const declared = project.ranges.get(name);
  if (!installed && declared === undefined) throw new Error(`${name} is not a dependency in this project's package.json.`);
  if (!options.targetVersion?.trim()) throw new Error('Choose the version to upgrade to.');

  const sourceTexts: { name: string; text: string }[] = [];
  let sourceBytes = 0;
  for (const source of await scanSources(realRoot, omitted, options.signal)) {
    const info = await stat(source.file);
    if (info.size > INTAKE_LIMITS.fileBytes) { omitted.add(`${source.name}: larger than 1 MiB`); continue; }
    sourceBytes += info.size;
    if (sourceBytes > INTAKE_LIMITS.totalBytes) { omitted.add(`${source.name}: over the 16 MiB total limit`); continue; }
    sourceTexts.push({ name: source.name, text: await readFile(source.file, 'utf8') });
  }
  const imported = new Set<string>();
  const nodeImporters: string[] = [];
  for (const source of sourceTexts) {
    const references = readImportReferences(source.text, source.name);
    let usesNode = references.types.includes('node');
    for (const specifier of references.modules) {
      if (specifier.startsWith(`${name}/`)) imported.add(specifier.slice(name.length));
      else if (isBuiltin(specifier) && (specifier.startsWith('node:') || !project.ranges.has(specifier.split('/')[0] ?? ''))) usesNode = true;
    }
    if (usesNode) nodeImporters.push(source.name);
  }
  if (nodeImporters.length > 0) {
    const examples = nodeImporters.slice(0, 3).join(', ') + (nodeImporters.length > 3 ? `, and ${nodeImporters.length - 3} more` : '');
    omitted.add(`@types/node: ${examples} ${nodeImporters.length === 1 ? 'imports' : 'import'} Node.js built-in modules; @types/node is not included, so those imports stay unresolved on both versions`);
  }
  const subpaths = [...imported].sort();

  const beforeSide = (async () => {
    if (installed) return prepareSide(localPackage(name, installed), `before, installed ${installed.version}`, realRoot, registry, omitted, subpaths);
    const locked = await lockedVersion(realRoot, name);
    const version = locked ?? await resolvePublishedVersion(name, declared ?? '', registry);
    const side = await prepareSide(await publishedPackage(name, version, registry), `before ${version}`, realRoot, registry, omitted, subpaths);
    side.label = locked ? `${name} ${version} (from package-lock.json), downloaded from npm (not installed)`
      : declared === version ? `${name} ${version}, downloaded from npm (not installed)`
      : `${name} ${version} (the highest published match for "${declared}"), downloaded from npm (not installed)`;
    return side;
  })();
  const afterSide = (async () => {
    const version = await resolvePublishedVersion(name, options.targetVersion, registry);
    return prepareSide(await publishedPackage(name, version, registry), `after ${version}`, realRoot, registry, omitted, subpaths);
  })();
  const [before, after] = await Promise.all([beforeSide, afterSide]);
  if (before.pkg.version === after.pkg.version) throw new Error(`${name} is already at ${after.pkg.version}; choose a different target version.`);

  const budget = new Budget(omitted);
  const beforeSnapshot = await snapshotOf(before, budget);
  const afterSnapshot = await snapshotOf(after, budget);
  const sources: Record<string, string> = {};
  const sourceCases = new CaseGuard(omitted);
  for (const source of sourceTexts) if (sourceCases.admit(source.name, source.name) && budget.take(source.name, source.text)) sources[source.name] = source.text;
  if (Object.keys(sources).length === 0) throw new Error('No .ts source files were found in this project outside node_modules, build output and hidden folders.');
  await addTypeDependencies(beforeSnapshot, before, budget, omitted);
  await addTypeDependencies(afterSnapshot, after, budget, omitted);

  const describeTypes = (side: Side) => {
    const parts = [side.fromDisk && `${side.fromDisk} from node_modules`, side.fromRegistry && `${side.fromRegistry} downloaded from npm`].filter(Boolean);
    return parts.length ? `; type dependencies: ${parts.join(', ')}` : '';
  };
  const intent = manifest.ketchup?.intent?.trim();
  return {
    format: 1,
    name: folder.slice(0, 120) || 'Project',
    description: (manifest.description?.trim() ?? '').slice(0, 2000),
    ...(intent ? { intent } : {}),
    origin: {
      kind: 'project', folder,
      declarationSources: {
        before: `${installed ? `${name} ${installed.version} from node_modules` : before.label}${describeTypes(before)}`,
        after: `${name} ${after.pkg.version}, downloaded from npm${describeTypes(after)}`,
      },
      omitted: omitted.list(),
    },
    dependency: { name, before: beforeSnapshot, after: afterSnapshot },
    sources,
  };
}
