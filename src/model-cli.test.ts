import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelCli } from './model-cli';

// A stand-in for tokyo-zen-cli: echoes stdin back so tests can see exactly what arrived.
function fakeCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-cli-'));
  const bin = join(dir, 'fake-cli');
  writeFileSync(bin, '#!/usr/bin/env node\nlet d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("LEN="+d.length+"\\n"+d.slice(0,200)));\n');
  chmodSync(bin, 0o755);
  return bin;
}

test('a prompt larger than the argv limit reaches the CLI intact (was E2BIG)', async () => {
  const prompt = 'x'.repeat(3 * 1024 * 1024);
  const out = await runModelCli(fakeCli(), [], prompt, { timeout: 20_000 });
  assert.match(out, new RegExp('^LEN=' + prompt.length));
});

test('shell syntax in a prompt is data, never executed', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'inj-')), 'pwned');
  const prompt = `hello $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}`;
  const out = await runModelCli(fakeCli(), [], prompt, { timeout: 10_000 });
  assert.ok(out.includes('$(touch'), 'prompt should arrive verbatim');
  assert.equal(existsSync(marker), false, 'shell syntax in the prompt was executed');
});

test('a failing CLI rejects with its stderr attached', async () => {
  await assert.rejects(runModelCli('/bin/sh', ['-c', 'echo boom >&2; exit 3'], 'hi', { timeout: 5_000 }),
    (err: any) => err.stderr.includes('boom'));
});
