import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { gateRepair } from './gate.ts';
import { inventoryApi } from './surface.ts';
import type { AnalysisReport, DemoEvidence, Diagnostic, MigrationBundle, PackageTypes, PatchReport, Snapshot, SourceEdit } from './types.ts';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 4000;
const ROOT = '/ketchup';
const contents = z.string().refine((text) => Buffer.byteLength(text) <= MAX_FILE_BYTES, 'Each file must be at most 1 MiB');
const relativePath = z.string().min(1).max(400).refine((name) => {
  const segments = name.split('/');
  return segments.every((part) => /^[a-zA-Z0-9_@.-]+$/.test(part)
    && part !== '.' && part !== '..' && !part.startsWith('.env')
    && part !== '.git' && part !== 'node_modules');
}, 'Use a relative path without traversal, secrets, .git or node_modules');
const sourcePath = relativePath.refine((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'), 'Sources must be .ts files');
const declarationPath = relativePath.refine((name) => /\.d\.[cm]?ts$/.test(name), 'Contracts must be .d.ts, .d.mts or .d.cts files');
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'Use a valid npm package name');
const subpathKey = z.string().max(400).refine((key) => /^\.\/[a-zA-Z0-9_@.\/-]+$/.test(key)
  && key.slice(2).split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Subpath keys look like ./sub, without traversal');
const packageTypesFields = {
  version: z.string().min(1).max(80),
  entry: declarationPath,
  files: z.record(declarationPath, contents),
  exports: z.record(subpathKey, declarationPath).optional(),
};
const entriesExist = (types: { entry: string; files: Record<string, string>; exports?: Record<string, string> | undefined }, ctx: z.RefinementCtx) => {
  if (!Object.hasOwn(types.files, types.entry)) ctx.addIssue({ code: 'custom', message: 'The contract entry must exist in files' });
  for (const [key, file] of Object.entries(types.exports ?? {})) {
    if (!Object.hasOwn(types.files, file)) ctx.addIssue({ code: 'custom', message: `The ${key} export must name one of the files` });
  }
};
const packageTypesSchema = z.object(packageTypesFields).strict().superRefine(entriesExist);
const snapshotSchema = z.object({
  ...packageTypesFields,
  typeDependencies: z.record(packageName, packageTypesSchema).optional(),
}).strict().superRefine(entriesExist);
const bundleSchema = z.object({
  format: z.literal(1),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  intent: z.string().max(4000).optional(),
  origin: z.object({
    kind: z.literal('project'),
    folder: z.string().min(1).max(200).refine((name) => !/[\\/]/.test(name), 'Use the folder name only, not a path'),
    declarationSources: z.object({ before: z.string().max(1000), after: z.string().max(1000) }).strict(),
    omitted: z.array(z.string().max(1000)).max(MAX_FILES),
  }).strict().optional(),
  dependency: z.object({
    name: packageName,
    source: z.object({ kind: z.literal('published-contract'), publisher: z.string().min(1).max(200), url: z.string().url().startsWith('https://') }).strict().optional(),
    before: snapshotSchema,
    after: snapshotSchema,
  }).strict(),
  sources: z.record(sourcePath, contents),
}).strict().superRefine((bundle, ctx) => {
  const snapshots = [bundle.dependency.before, bundle.dependency.after];
  const groups = [bundle.sources, ...snapshots.flatMap((snapshot) => [snapshot.files, ...Object.values(snapshot.typeDependencies ?? {}).map((item) => item.files)])];
  if (Object.keys(bundle.sources).length === 0) ctx.addIssue({ code: 'custom', message: 'Include at least one source file' });
  if (snapshots.some((snapshot) => Object.hasOwn(snapshot.typeDependencies ?? {}, bundle.dependency.name))) {
    ctx.addIssue({ code: 'custom', message: 'typeDependencies cannot include the dependency itself' });
  }
  if (groups.reduce((total, group) => total + Object.keys(group).length, 0) > MAX_FILES) ctx.addIssue({ code: 'custom', message: `A bundle may contain at most ${MAX_FILES} files across sources and declarations` });
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) ctx.addIssue({ code: 'custom', message: 'The complete bundle must be at most 16 MiB' });
  for (const group of groups) {
    const seen = new Map<string, string>();
    for (const key of Object.keys(group)) {
      const other = seen.get(key.toLowerCase());
      if (other !== undefined) ctx.addIssue({ code: 'custom', message: `File paths must be unique ignoring case: ${other} and ${key}` });
      seen.set(key.toLowerCase(), key);
    }
  }
});
const editSchema = z.array(z.object({ path: sourcePath, before: contents.refine((text) => text.length > 0, 'An edit needs nonempty original text'), after: contents }).strict()).min(1).max(100);

export function validateBundle(input: unknown): MigrationBundle {
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid migration bundle: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'bundle'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  strict: true,
  noEmit: true,
  noUncheckedSideEffectImports: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  allowImportingTsExtensions: true,
  skipLibCheck: false,
  types: [],
};
const libraryDirectory = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
const libraryFiles = new Map<string, ts.SourceFile>();
const libraries = new Map(readdirSync(libraryDirectory)
  .filter((name) => /^lib\.[a-z0-9.-]+\.d\.ts$/.test(name))
  .map((name) => {
    const filename = path.join(libraryDirectory, name);
    return [filename, readFileSync(filename, 'utf8')];
  }));

/** Unused-binding diagnostics (TS6133 and its siblings). They are kept apart from errors so they never count as upgrade errors. */
const UNUSED_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205]);

interface Compilation { program: ts.Program; entry: string; diagnostics: Diagnostic[]; unused: Diagnostic[] }

function compile(bundle: MigrationBundle, snapshot: Snapshot, sources: Record<string, string>): Compilation {
  const packageRoot = `${ROOT}/node_modules/${bundle.dependency.name}`;
  const files = new Map<string, string>(libraries);
  for (const [name, text] of Object.entries(sources)) files.set(`${ROOT}/${name}`, text);
  const mount = (name: string, types: PackageTypes) => {
    for (const [file, text] of Object.entries(types.files)) files.set(`${ROOT}/node_modules/${name}/${file}`, text);
    const exports = types.exports && Object.fromEntries([['.', types.entry], ...Object.entries(types.exports)].map(([key, file]) => [key, { types: `./${file}` }]));
    files.set(`${ROOT}/node_modules/${name}/package.json`, JSON.stringify({ name, version: types.version, types: types.entry, ...(exports && { exports }) }));
  };
  for (const [name, types] of Object.entries(snapshot.typeDependencies ?? {})) mount(name, types);
  mount(bundle.dependency.name, snapshot);
  const directories = new Set<string>();
  const directory = (name: string) => path.posix.normalize(name).replace(/(.)\/+$/, '$1');
  for (const filename of files.keys()) {
    let current = path.posix.dirname(filename);
    while (current !== '/') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  const host: ts.CompilerHost = {
    getSourceFile(filename, languageVersion) {
      const name = path.posix.normalize(filename);
      const text = files.get(name);
      if (text === undefined) return undefined;
      if (!libraries.has(name)) return ts.createSourceFile(filename, text, languageVersion, true);
      const cached = libraryFiles.get(name) ?? ts.createSourceFile(filename, text, languageVersion, true);
      libraryFiles.set(name, cached);
      return cached;
    },
    getDefaultLibFileName: () => ts.getDefaultLibFilePath(compilerOptions),
    writeFile: () => { throw new Error('This compiler cannot write files'); },
    getCurrentDirectory: () => ROOT,
    getDirectories: (parent) => [...directories].filter((name) => path.posix.dirname(name) === directory(parent)).map((name) => path.posix.basename(name)),
    getCanonicalFileName: (filename) => filename,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (filename) => files.has(path.posix.normalize(filename)),
    readFile: (filename) => files.get(path.posix.normalize(filename)),
    directoryExists: (name) => directories.has(directory(name)),
    realpath: (filename) => path.posix.normalize(filename),
  };
  const entry = `${packageRoot}/${snapshot.entry}`;
  const globalTypes = Object.keys(snapshot.typeDependencies ?? {}).filter((name) => name.startsWith('@types/')).map((name) => name.slice('@types/'.length));
  const program = ts.createProgram([...Object.keys(sources).map((name) => `${ROOT}/${name}`), entry], { ...compilerOptions, types: globalTypes }, host);
  const all = ts.getPreEmitDiagnostics(program).filter((item) => item.category === ts.DiagnosticCategory.Error).map((item) => {
    const point = item.file?.getLineAndCharacterOfPosition(item.start ?? 0);
    const name = item.file?.fileName ?? '(compiler)';
    return {
      code: item.code,
      file: name.startsWith(`${packageRoot}/`) ? `contracts/${name.slice(packageRoot.length + 1)}` : name.startsWith(`${ROOT}/`) ? name.slice(ROOT.length + 1) : name.startsWith(libraryDirectory) ? `typescript/${path.basename(name)}` : name,
      line: (point?.line ?? 0) + 1,
      column: (point?.character ?? 0) + 1,
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
    };
  });
  return { program, entry, diagnostics: all.filter((item) => !UNUSED_CODES.has(item.code)), unused: all.filter((item) => UNUSED_CODES.has(item.code)) };
}

function introducedDiagnostics(baseline: Diagnostic[], target: Diagnostic[], matchLocation = true, preexisting: Diagnostic[] = []): Diagnostic[] {
  const key = (item: Diagnostic) => JSON.stringify([item.file, item.code, item.message, ...(matchLocation ? [item.line, item.column] : [])]);
  const existing = new Map<string, number>();
  for (const item of baseline) existing.set(key(item), (existing.get(key(item)) ?? 0) + 1);
  return target.filter((item) => {
    const count = existing.get(key(item)) ?? 0;
    if (count === 0) return true;
    existing.set(key(item), count - 1);
    preexisting.push(item);
    return false;
  });
}

export function analyzeBundle(bundle: MigrationBundle): AnalysisReport {
  const before = compile(bundle, bundle.dependency.before, bundle.sources);
  const after = compile(bundle, bundle.dependency.after, bundle.sources);
  const baseline = before.diagnostics;
  const target = after.diagnostics;
  const introduced = introducedDiagnostics(baseline, target);
  const { apiChanges, coverage } = inventoryApi({
    before: before.program, after: after.program, beforeEntry: before.entry, afterEntry: after.entry,
    sources: Object.fromEntries(Object.keys(bundle.sources).map((name) => [name, `${ROOT}/${name}`])),
    dependencyRoot: `${ROOT}/node_modules/`, dependency: bundle.dependency.name, introduced, omitted: bundle.origin?.omitted,
  });
  return {
    baseline, target, introduced,
    findings: introduced.map((item) => ({
      ...item,
      id: createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 12),
      title: item.message.split('\n')[0] ?? `TypeScript error ${item.code}`,
      detail: item.message,
      snippet: bundle.sources[item.file]?.split('\n')[item.line - 1]?.trim() ?? '',
    })),
    apiChanges, coverage,
    sourceCount: Object.keys(bundle.sources).length,
    affectedFileCount: new Set(introduced.filter((item) => Object.hasOwn(bundle.sources, item.file)).map((item) => item.file)).size,
    checkedAt: new Date().toISOString(),
  };
}

function applyEdits(bundle: MigrationBundle, input: SourceEdit[]): Record<string, string> {
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid source edits: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  const grouped = new Map<string, { start: number; end: number; after: string }[]>();
  for (const edit of parsed.data) {
    const original = bundle.sources[edit.path];
    if (original === undefined) throw new Error(`Cannot edit ${edit.path}: only existing source files may change`);
    if (edit.before === edit.after) throw new Error(`The edit to ${edit.path} makes no change`);
    if (/@ts-(?:ignore|nocheck|expect-error)\b/i.test(edit.after)) throw new Error('Candidate edits may not contain TypeScript suppression directives');
    const start = original.indexOf(edit.before);
    if (start < 0) throw new Error(`Original text not found in ${edit.path}. Edits always apply to the original file, not to an earlier candidate: copy before from read_file, or omit before and send the complete new file`);
    if (original.indexOf(edit.before, start + 1) >= 0) throw new Error(`Original text is ambiguous in ${edit.path}; include more context`);
    const edits = grouped.get(edit.path) ?? [];
    edits.push({ start, end: start + edit.before.length, after: edit.after });
    grouped.set(edit.path, edits);
  }
  const files = { ...bundle.sources };
  for (const [name, edits] of grouped) {
    edits.sort((a, b) => a.start - b.start);
    for (let index = 1; index < edits.length; index++) {
      const previous = edits[index - 1];
      const current = edits[index];
      if (previous && current && previous.end > current.start) throw new Error(`Overlapping edits in ${name}`);
    }
    let text = files[name] ?? '';
    for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.after + text.slice(edit.end);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`The edited file ${name} exceeds 1 MiB`);
    files[name] = text;
  }
  if (Buffer.byteLength(JSON.stringify({ ...bundle, sources: files })) > MAX_BUNDLE_BYTES) throw new Error('The edited bundle exceeds 16 MiB');
  return files;
}

function editScript(a: string[], b: string[]): ('=' | '-' | '+')[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const x = a.slice(prefix, a.length - suffix);
  const y = b.slice(prefix, b.length - suffix);
  const n = x.length, m = y.length, offset = n + m + 1;
  const limit = Math.min(n + m, 2000);
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; !found && d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) { i++; j++; }
      v[offset + k] = i;
      if (i >= n && j >= m) { found = true; break; }
    }
  }
  const same = (count: number) => Array<'='>(count).fill('=');
  if (!found) return [...same(prefix), ...Array<'-'>(n).fill('-'), ...Array<'+'>(m).fill('+'), ...same(suffix)];
  const middle: ('=' | '-' | '+')[] = [];
  let i = n, j = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const previous = trace[d]!;
    const at = (diagonal: number) => previous[diagonal + d + 1]!;
    const k = i - j;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const startI = down ? at(k + 1) : at(k - 1) + 1;
    const startJ = startI - k;
    while (i > startI && j > startJ) { middle.push('='); i--; j--; }
    if (d > 0) { middle.push(down ? '+' : '-'); if (down) j--; else i--; }
  }
  while (i > 0 && j > 0) { middle.push('='); i--; j--; }
  return [...same(prefix), ...middle.reverse(), ...same(suffix)];
}

export function makeDiff(before: Record<string, string>, after: Record<string, string>): string {
  const lines = (text: string) => text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const range = (start: number, count: number) => count === 0 ? `${start},0` : `${start + 1},${count}`;
  const context = 3;
  const output: string[] = [];
  const emit = (prefix: string, line: string) => {
    output.push(prefix + (line.endsWith('\n') ? line.slice(0, -1) : line));
    if (!line.endsWith('\n')) output.push('\\ No newline at end of file');
  };
  for (const name of Object.keys(before).sort()) {
    const original = before[name];
    const updated = after[name];
    if (original === undefined || updated === undefined || original === updated) continue;
    const oldLines = lines(original);
    const newLines = lines(updated);
    const ops: { op: '=' | '-' | '+'; oldIndex: number; newIndex: number }[] = [];
    let oldIndex = 0, newIndex = 0;
    for (const op of editScript(oldLines, newLines)) {
      ops.push({ op, oldIndex, newIndex });
      if (op !== '+') oldIndex++;
      if (op !== '-') newIndex++;
    }
    output.push(`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`);
    const changed = ops.flatMap((item, index) => item.op === '=' ? [] : [index]);
    for (let group = 0; group < changed.length;) {
      let last = group;
      while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * context + 1) last++;
      const from = Math.max(0, changed[group]! - context);
      const to = Math.min(ops.length, changed[last]! + context + 1);
      const hunk = ops.slice(from, to);
      const first = hunk[0]!;
      const oldCount = hunk.filter((item) => item.op !== '+').length;
      const newCount = hunk.filter((item) => item.op !== '-').length;
      output.push(`@@ -${range(first.oldIndex, oldCount)} +${range(first.newIndex, newCount)} @@`);
      for (const item of hunk) {
        if (item.op === '+') emit('+', newLines[item.newIndex]!);
        else emit(item.op === '-' ? '-' : ' ', oldLines[item.oldIndex]!);
      }
      group = last + 1;
    }
  }
  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}

export function checkPatch(bundle: MigrationBundle, edits: SourceEdit[]): PatchReport {
  const files = applyEdits(bundle, edits);
  const baseline = compile(bundle, bundle.dependency.before, bundle.sources).diagnostics;
  const original = compile(bundle, bundle.dependency.after, bundle.sources);
  const originalTarget = original.diagnostics;
  const edited = compile(bundle, bundle.dependency.after, files);
  const diagnostics = edited.diagnostics;
  const preexisting: Diagnostic[] = [];
  const remaining = introducedDiagnostics(baseline, diagnostics, false, preexisting);
  const originalIntroduced = introducedDiagnostics(baseline, originalTarget);
  const violations = gateRepair(bundle.sources, files, introducedDiagnostics(original.unused, edited.unused, false));
  return {
    accepted: remaining.length === 0 && violations.length === 0,
    diagnostics, remaining, preexisting, violations,
    resolvedCount: introducedDiagnostics(diagnostics, originalIntroduced, false).length,
    files,
    diff: makeDiff(bundle.sources, files),
    checkedAt: new Date().toISOString(),
  };
}

/** Scenario checks that failed; `not-run` checks establish nothing and are not failures. */
export const failedChecks = (demo: DemoEvidence | null | undefined) => (demo?.checks ?? []).filter((check) => check.status === 'failed');

/** A repair is accepted when it passes the compiler and the repair rules and, for a bundled example, every scenario check that ran. */
export const repairAccepted = (report: PatchReport, demo: DemoEvidence | null | undefined) => report.accepted && failedChecks(demo).length === 0;
