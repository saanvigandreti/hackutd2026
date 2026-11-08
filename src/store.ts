import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { analyzeBundle, checkPatch, validateBundle } from './engine.ts';
import { demoEvidence, demoIdOf, findingHeadlines, isDemoBundle } from './demo.ts';
import type { AnalysisReport, MigrationBundle, Workspace } from './types.ts';

export const MAX_WORKSPACES = 25;
const savedName = /^[a-f\d-]{36}\.json$/;

/** Analysis with consequence-first finding titles for a bundled example; the compiler text stays in each finding's detail. */
function analyze(bundle: MigrationBundle): AnalysisReport {
  const analysis = analyzeBundle(bundle);
  return { ...analysis, findings: findingHeadlines(bundle, analysis.findings) };
}

const savedSchema = z.object({
  id: z.string().uuid(),
  bundle: z.unknown(),
  updatedAt: z.string().datetime().optional(),
  draft: z.object({
    origin: z.enum(['nemotron', 'rehearsal']),
    model: z.string().min(1).max(200).optional(),
    proposal: z.object({
      summary: z.string().max(4000), rationale: z.string().max(16000),
      edits: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })).max(60),
    }),
    review: z.object({
      origin: z.literal('nemotron'), summary: z.string().max(4000),
      risks: z.array(z.object({ file: z.string(), line: z.number().int().nullable(), concern: z.string().max(4000) })).max(50),
    }).nullable().optional(),
  }).nullable(),
  events: z.array(z.object({
    at: z.string(), kind: z.enum(['plan', 'tool', 'check', 'review', 'complete', 'error']),
    title: z.string().max(1000), detail: z.string().max(20000),
  })).max(200),
});

const archivedSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().optional(),
  bundle: z.object({ name: z.string(), dependency: z.object({ name: z.string(), before: z.object({ version: z.string() }), after: z.object({ version: z.string() }) }) }),
  draft: z.object({ origin: z.string() }).nullable(),
});

export interface ArchivedProject {
  id: string;
  name: string;
  dependency: string;
  from: string;
  to: string;
  drafted: boolean;
  updatedAt: string;
}

export class CapacityError extends Error {
  constructor() { super(`Ketchup keeps up to ${MAX_WORKSPACES} active projects. Archive a project you have finished with, then try again. Archived projects can be restored at any time.`); }
}

export class WorkspaceStore {
  readonly items = new Map<string, Workspace>();
  readonly warnings: string[] = [];

  readonly directory: string;
  readonly archiveDirectory: string;
  constructor(directory: string) { this.directory = directory; this.archiveDirectory = path.join(directory, 'archive'); }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory)).filter((item) => savedName.test(item))) {
      try { const workspace = await this.load(path.join(this.directory, name)); this.items.set(workspace.id, workspace); }
      catch { this.warnings.push(`A saved workspace could not be loaded: ${name}. Its file was preserved.`); }
    }
  }

  private async load(filename: string): Promise<Workspace> {
    const saved = savedSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    if (path.basename(filename) !== `${saved.id}.json`) throw new Error('Workspace ID mismatch');
    const bundle = validateBundle(saved.bundle);
    const report = saved.draft ? checkPatch(bundle, saved.draft.proposal.edits) : null;
    return {
      id: saved.id, bundle, analysis: analyze(bundle), demoAvailable: isDemoBundle(bundle), demoId: demoIdOf(bundle),
      draft: saved.draft && report ? { ...saved.draft, report, demo: demoEvidence(bundle, report, saved.draft.origin) } : null,
      events: saved.events, updatedAt: saved.updatedAt ?? (await stat(filename)).mtime.toISOString(),
    };
  }

  assertCapacity(): void { if (this.items.size >= MAX_WORKSPACES) throw new CapacityError(); }

  async create(input: unknown): Promise<Workspace> {
    this.assertCapacity();
    const bundle = validateBundle(input);
    const workspace: Workspace = {
      id: randomUUID(), bundle, analysis: analyze(bundle), demoAvailable: isDemoBundle(bundle), demoId: demoIdOf(bundle),
      draft: null, events: [],
    };
    await this.save(workspace);
    return this.items.get(workspace.id) ?? workspace;
  }

  async save(workspace: Workspace): Promise<void> {
    const updatedAt = new Date().toISOString();
    const destination = path.join(this.directory, `${workspace.id}.json`);
    const temporary = path.join(this.directory, `${workspace.id}.${randomUUID()}.tmp`);
    const saved = {
      id: workspace.id, updatedAt, bundle: workspace.bundle, events: workspace.events.slice(-200),
      draft: workspace.draft ? { origin: workspace.draft.origin, ...(workspace.draft.model ? { model: workspace.draft.model } : {}), proposal: workspace.draft.proposal, review: workspace.draft.review ?? null } : null,
    };
    await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    await rename(temporary, destination);
    this.items.set(workspace.id, { ...workspace, updatedAt });
  }

  list(): Workspace[] {
    return [...this.items.values()].sort((first, second) => (second.updatedAt ?? '').localeCompare(first.updatedAt ?? ''));
  }

  async archive(id: string): Promise<void> {
    const workspace = this.items.get(id);
    if (!workspace) throw new Error('This workspace was not found.');
    this.items.delete(id);
    try {
      await mkdir(this.archiveDirectory, { recursive: true, mode: 0o700 });
      await rename(path.join(this.directory, `${id}.json`), path.join(this.archiveDirectory, `${id}.json`));
    } catch {
      this.items.set(id, workspace);
      throw new Error('This project could not be archived. Its file was left in place.');
    }
  }

  async listArchived(): Promise<ArchivedProject[]> {
    let names: string[];
    try { names = (await readdir(this.archiveDirectory)).filter((item) => savedName.test(item)); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
    const projects: ArchivedProject[] = [];
    for (const name of names) {
      const filename = path.join(this.archiveDirectory, name);
      try {
        const saved = archivedSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
        const { dependency } = saved.bundle;
        projects.push({
          id: saved.id, name: saved.bundle.name, dependency: dependency.name, from: dependency.before.version, to: dependency.after.version,
          drafted: saved.draft !== null, updatedAt: saved.updatedAt ?? (await stat(filename)).mtime.toISOString(),
        });
      } catch { /* An unreadable archive file stays on disk untouched. */ }
    }
    return projects.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  }

  async restore(id: string): Promise<Workspace> {
    this.assertCapacity();
    const archived = path.join(this.archiveDirectory, `${id}.json`);
    let workspace: Workspace;
    try { workspace = await this.load(archived); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('This archived project was not found.');
      throw new Error('This archived project could not be read. Its file was preserved in the archive folder.');
    }
    if (this.items.has(id)) throw new Error('This project is already open.');
    this.items.set(id, workspace);
    try { await rename(archived, path.join(this.directory, `${id}.json`)); }
    catch { this.items.delete(id); throw new Error('This archived project could not be restored. Its file was preserved in the archive folder.'); }
    return workspace;
  }
}
