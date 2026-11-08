import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

type Files = Record<string, string>;
export const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')) as {
  project: Files;
  installed: Record<string, Files>;
  published: Record<string, Record<string, Files | 'installed'>>;
};

export function writeTree(root: string, files: Files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** Writes the fixture project and its installed packages under `root`. */
export function writeProject(root: string, options: { installed?: boolean } = {}) {
  writeTree(root, fixture.project);
  if (options.installed === false) return;
  for (const [name, files] of Object.entries(fixture.installed)) writeTree(path.join(root, 'node_modules', ...name.split('/')), files);
}

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write(type, 156, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.fill(32, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}
const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** A minimal ustar archive; names over 100 bytes get a pax `path` record, as npm's packer writes them. */
export function tar(files: Files, prefix = 'package'): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const full = `${prefix}/${name}`;
    if (Buffer.byteLength(full) > 100) {
      let record = '';
      for (let length = 0; ;) {
        record = `${length} path=${full}\n`;
        if (Buffer.byteLength(record) === length) break;
        length = Buffer.byteLength(record);
      }
      blocks.push(header('PaxHeader', Buffer.byteLength(record), 'x'), padded(Buffer.from(record)));
    }
    const data = Buffer.from(text);
    blocks.push(header(full, data.length, '0'), padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const tarballUrl = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
const integrityOf = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export interface StubRegistry {
  fetchImpl: typeof fetch;
  requests: string[];
  /** Replaces one version's published integrity, as a tampered mirror would. */
  tamper(name: string, version: string): void;
}

/** A local stand-in for registry.npmjs.org built from the fixture; it never touches the network. */
export function stubRegistry(published = fixture.published, extra: Record<string, Record<string, Files>> = {}): StubRegistry {
  const tarballs = new Map<string, Buffer>();
  const packuments = new Map<string, { name: string; 'dist-tags': Record<string, string>; versions: Record<string, unknown> }>();
  const all = { ...published, ...extra };
  for (const [name, versions] of Object.entries(all)) {
    const entry = { name, 'dist-tags': {} as Record<string, string>, versions: {} as Record<string, unknown> };
    for (const [version, content] of Object.entries(versions)) {
      const files = content === 'installed' ? fixture.installed[name] ?? {} : content;
      const manifest = JSON.parse(files['package.json'] ?? '{}') as Record<string, unknown>;
      const bytes = gzipSync(tar(files));
      tarballs.set(tarballUrl(name, version), bytes);
      entry.versions[version] = { ...manifest, version, dist: { tarball: tarballUrl(name, version), integrity: integrityOf(bytes), shasum: 'unused' } };
      if (!version.includes('-')) entry['dist-tags'].latest = version;
    }
    packuments.set(`https://registry.npmjs.org/${encodeURIComponent(name)}`, entry);
  }
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const packument = packuments.get(url);
    if (packument) return new Response(JSON.stringify(packument), { status: 200, headers: { 'content-type': 'application/json' } });
    const tarball = tarballs.get(url);
    if (tarball) return new Response(new Uint8Array(tarball), { status: 200 });
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl, requests,
    tamper(name, version) {
      const packument = packuments.get(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      const record = packument?.versions[version] as { dist: { integrity: string } } | undefined;
      if (record) record.dist.integrity = integrityOf(Buffer.from('tampered'));
    },
  };
}
