import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDiff } from '../src/engine.ts';

test('a focused diff applies additions, deletions and final-newline changes without replacing unchanged lines', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-diff-'));
  const fixtures = [
    ['one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n', 'one\ntwo\nthree\nfour\nchanged\nsix\nseven\neight\nnine\n'],
    ['', 'added\n'], ['removed\n', ''], ['same', 'same\n'], ['same\n', 'same'],
    ['keep\nlast', 'keep\nchanged'], ['keep\n', 'keep\nadded\n'],
    ['keep\nremove\n', 'keep\n'],
  ];
  try {
    for (const [before, after] of fixtures) {
      assert.notEqual(before, undefined); assert.notEqual(after, undefined);
      if (before === undefined || after === undefined) throw new Error('Missing diff fixture');
      await writeFile(path.join(directory, 'source.ts'), before);
      const patch = makeDiff({ 'source.ts': before }, { 'source.ts': after });
      if (before.startsWith('one\n')) {
        assert.equal(patch.includes('-one'), false);
        assert.equal(patch.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length, 1);
      }
      execFileSync('git', ['apply', '-'], { cwd: directory, input: patch });
      assert.equal(await readFile(path.join(directory, 'source.ts'), 'utf8'), after);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('two distant edits in a 200-line file produce two small hunks that git applies exactly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-diff-'));
  try {
    const before = Array.from({ length: 200 }, (_, index) => `const v${index} = ${index};`).join('\n') + '\n';
    const after = before.replace('const v5 = 5;', 'const v5 = 50;').replace('const v195 = 195;', 'const v195 = 1950;');
    const patch = makeDiff({ 'a.ts': before }, { 'a.ts': after });
    const lines = patch.split('\n');
    assert.deepEqual(lines.filter(line => line.startsWith('@@')), ['@@ -3,7 +3,7 @@', '@@ -193,7 +193,7 @@']);
    assert.deepEqual(lines.filter(line => /^[-+](?![-+]{2} )/.test(line)), ['-const v5 = 5;', '+const v5 = 50;', '-const v195 = 195;', '+const v195 = 1950;']);
    await writeFile(path.join(directory, 'a.ts'), before);
    execFileSync('git', ['apply', '-'], { cwd: directory, input: patch });
    assert.equal(await readFile(path.join(directory, 'a.ts'), 'utf8'), after);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('nearby edits share a hunk and a missing final newline is marked on both sides', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-diff-'));
  try {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 2\n', 'line two\n').replace('line 6\n', '').replace('line 29', 'last line\n');
    const patch = makeDiff({ 'b.ts': before }, { 'b.ts': after });
    assert.equal(patch.split('\n').filter(line => line.startsWith('@@')).length, 2);
    assert.equal(patch.split('\n').filter(line => line === '\\ No newline at end of file').length, 1);
    await writeFile(path.join(directory, 'b.ts'), before);
    execFileSync('git', ['apply', '-'], { cwd: directory, input: patch });
    assert.equal(await readFile(path.join(directory, 'b.ts'), 'utf8'), after);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('random edits always round-trip through git apply', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-diff-'));
  let seed = 7;
  const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  try {
    for (let round = 0; round < 25; round++) {
      const before = Array.from({ length: 5 + random(60) }, () => `row ${random(8)}`);
      const after = before.flatMap(line => { const roll = random(10); return roll === 0 ? [] : roll === 1 ? [line, `new ${random(8)}`] : roll === 2 ? [`edit ${random(8)}`] : [line]; });
      const oldText = before.join('\n') + (random(2) ? '\n' : '');
      const newText = after.join('\n') + (random(2) ? '\n' : '');
      await writeFile(path.join(directory, 'c.ts'), oldText);
      const patch = makeDiff({ 'c.ts': oldText }, { 'c.ts': newText });
      if (patch) execFileSync('git', ['apply', '-'], { cwd: directory, input: patch });
      assert.equal(await readFile(path.join(directory, 'c.ts'), 'utf8'), newText, `round ${round}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a whole-file rewrite of a large file stays bounded and still applies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-diff-'));
  try {
    const before = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join('\n') + '\n';
    const after = Array.from({ length: 3000 }, (_, index) => index % 2 ? `old ${index}` : `new ${index}`).join('\n') + '\n';
    const started = performance.now();
    const patch = makeDiff({ 'big.ts': before }, { 'big.ts': after });
    assert.ok(performance.now() - started < 2000);
    await writeFile(path.join(directory, 'big.ts'), before);
    execFileSync('git', ['apply', '-'], { cwd: directory, input: patch, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(await readFile(path.join(directory, 'big.ts'), 'utf8'), after);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
