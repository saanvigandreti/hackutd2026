# Ketchup

Ketchup helps migrate TypeScript code when a dependency changes its API. It compares the old and new declarations, locates affected code, and checks proposed repairs before exporting a patch.

## Start

Requires Node.js 22.18 or newer and npm. From the project folder:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm start
```

Open the address printed in the terminal. The default is `http://127.0.0.1:4317`.

The bundled GPU-alert and OpenTelemetry examples include reference repairs and work without an API key. Their analysis uses bundled inputs. To enable hosted drafting, set `NVIDIA_API_KEY` in the process environment before starting. You can also create a local `.env` file in an editor; `npm start` loads it. Keep keys out of shared files.

## Use it

1. Open a local TypeScript project, choose a bundled example, or import a migration bundle.
2. Review the compiler findings and API changes.
3. Request a Nemotron repair or check an example's reference repair.
4. Review the patch and handoff report before applying the changes yourself.

For folder intake, supply the project's full path, dependency, and target version. `examples/sensor-routing` is a small project for trying this workflow with Zod.

Repairs must pass compiler and code-preservation checks. The bundled examples also check migration-specific behavior. These checks do not replace the receiving project's tests.

Ketchup exports a unified patch and a handoff report describing the changes, checks performed, and remaining work. It does not apply the patch to your project.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NVIDIA_API_KEY` | Enables hosted Nemotron drafting |
| `KETCHUP_PORT` | Overrides the default port |
| `KETCHUP_DATA_DIR` | Overrides local workspace storage |
| `KETCHUP_PROMETHEUS_URL` | Enables optional read-only metric checks |

Prometheus authentication uses either `KETCHUP_PROMETHEUS_BEARER_TOKEN` or `KETCHUP_PROMETHEUS_BASIC_AUTH`.

Ketchup asks before sending project content to NVIDIA or querying the configured Prometheus server. Package intake reads declarations from the public npm registry. Imported code and package scripts are not executed.

## Development checks

Install development dependencies before checking the project:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The check command runs TypeScript checking and local tests. The application runs TypeScript directly; there is no emitted build directory.

## Storage

Saved projects and package caches stay under `.ketchup/workspaces` unless `KETCHUP_DATA_DIR` is set. Saved projects can be archived and restored through the project menu.
