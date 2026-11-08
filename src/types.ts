export interface PackageTypes {
  version: string;
  entry: string;
  files: Record<string, string>;
  /** Subpath declaration entries from the package's `exports` map, keyed like `./sub`, each naming one of `files`. */
  exports?: Record<string, string>;
}

export interface Snapshot extends PackageTypes {
  /** Declarations of the packages this version's own declarations import, keyed by package name. */
  typeDependencies?: Record<string, PackageTypes>;
}

export interface BundleOrigin {
  kind: 'project';
  /** Folder name only; absolute paths stay on this machine. */
  folder: string;
  declarationSources: { before: string; after: string };
  /** Files or packages left out of the analysis, each with the reason. */
  omitted: string[];
}

export interface MigrationBundle {
  format: 1;
  name: string;
  description: string;
  /** Behavior the migration must keep, in the project's own words. */
  intent?: string;
  origin?: BundleOrigin;
  dependency: {
    name: string;
    /** Absent means an npm package. A published contract is not on npm, so registry lookups are skipped. */
    source?: { kind: 'published-contract'; publisher: string; url: string };
    before: Snapshot;
    after: Snapshot;
  };
  sources: Record<string, string>;
}

export interface Diagnostic {
  code: number;
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface Finding {
  id: string;
  title: string;
  detail: string;
  file: string;
  line: number;
  column: number;
  code: number;
  snippet: string;
}

export interface ApiChange {
  kind: 'removed' | 'changed' | 'deprecated';
  /** Exported path such as `MeterProvider.addMetricReader`. */
  symbol: string;
  before: string | null;
  after: string | null;
  /** Source locations that reference the symbol; empty means Ketchup could not place it in this code. */
  locations: { file: string; line: number }[];
}

export interface Coverage {
  status: 'complete' | 'partial' | 'unavailable';
  notes: string[];
}

export interface AnalysisReport {
  baseline: Diagnostic[];
  target: Diagnostic[];
  introduced: Diagnostic[];
  findings: Finding[];
  apiChanges: ApiChange[];
  coverage: Coverage;
  sourceCount: number;
  affectedFileCount: number;
  checkedAt: string;
}

export interface SourceEdit { path: string; before: string; after: string }
export interface PatchProposal { summary: string; rationale: string; edits: SourceEdit[] }

export interface GateViolation { rule: string; file: string; message: string }

export interface PatchReport {
  accepted: boolean;
  diagnostics: Diagnostic[];
  /** Errors introduced relative to the original code on the old version. */
  remaining: Diagnostic[];
  /** Errors that already existed before the upgrade and are unchanged by the patch. */
  preexisting: Diagnostic[];
  violations: GateViolation[];
  resolvedCount: number;
  files: Record<string, string>;
  diff: string;
  checkedAt: string;
}

export interface AgentEvent {
  at: string;
  kind: 'plan' | 'tool' | 'check' | 'review' | 'complete' | 'error';
  title: string;
  detail: string;
}

export interface RegistryMetadata {
  name: string;
  version: string;
  latest: string;
  description: string;
  publishedAt: string | null;
  deprecated: string | null;
  source: string;
}

export interface ScenarioCheck { name: string; status: 'passed' | 'failed' | 'not-run'; detail: string }

/** One operator-facing signal, shown as Alert / Original code / Repaired code. */
export interface OperatorSignal {
  name: string;
  meaning: string;
  original: string;
  repaired: string;
  /** Rule name, as the next action refers to it. */
  rule?: string;
  /** The alert as each version's rule states it: metric, direction and threshold expression. */
  alert?: { original: string; repaired: string };
}

export interface DemoEvidence {
  kind: string;
  candidateVerified: boolean;
  checks: ScenarioCheck[];
  operator: {
    headline: string;
    rows: OperatorSignal[];
    nextAction: string;
  } | null;
  note: string;
  sources: { label: string; url: string }[];
}

export interface BehaviorReview {
  origin: 'nemotron';
  risks: { file: string; line: number | null; concern: string }[];
  summary: string;
}

export interface DraftResult {
  origin: 'nemotron' | 'rehearsal';
  /** Model that drafted the proposal, recorded when the draft was made. */
  model?: string;
  proposal: PatchProposal;
  report: PatchReport;
  demo: DemoEvidence | null;
  review?: BehaviorReview | null;
}

export interface Workspace {
  id: string;
  bundle: MigrationBundle;
  analysis: AnalysisReport;
  demoAvailable: boolean;
  /** Id of the bundled example this workspace was created from, or null. */
  demoId?: string | null;
  draft: DraftResult | null;
  events: AgentEvent[];
  updatedAt?: string;
}

export type Job =
  | { id: string; status: 'running'; workspaceId: string; events: AgentEvent[] }
  | { id: string; status: 'complete'; workspaceId: string; events: AgentEvent[]; result: DraftResult }
  | { id: string; status: 'failed'; workspaceId: string; events: AgentEvent[]; error: string };
