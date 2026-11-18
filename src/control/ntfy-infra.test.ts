import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'ops', 'ntfy');
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');

test('server.yml is deny-all with no signup, no web UI, no attachments, no upstream', () => {
  const y = read('server.yml');
  assert.match(y, /^auth-default-access:\s*"?deny-all"?\s*$/m);
  assert.match(y, /^enable-signup:\s*false\s*$/m);
  assert.match(y, /^web-root:\s*"?disable"?\s*$/m);
  assert.match(y, /^behind-proxy:\s*true\s*$/m);
  assert.match(y, /^cache-duration:\s*"?12h"?\s*$/m);
  assert.doesNotMatch(y, /upstream-base-url/);
  assert.doesNotMatch(y, /attachment-cache-dir/);
});

test('compose.yml pins an exact tag, binds loopback only, limits memory', () => {
  const c = read('compose.yml');
  assert.match(c, /image:\s*binwiederhier\/ntfy:v\d+\.\d+\.\d+\s*$/m);
  assert.doesNotMatch(c, /:latest/);
  assert.match(c, /"127\.0\.0\.1:2586:80"/);
  assert.match(c, /mem_limit:\s*128m/);
  assert.match(c, /restart:\s*unless-stopped/);
  for (const v of ['etc', 'cache', 'lib']) assert.ok(c.includes(`/srv/ntfy/${v}:`), v);
});

test('nginx site proxies to loopback with websocket headers and small bodies', () => {
  const n = read('nginx-ntfy.conf');
  assert.match(n, /server_name ntfy\.203-0-113-10\.sslip\.io;/);
  assert.match(n, /proxy_pass http:\/\/127\.0\.0\.1:2586;/);
  assert.match(n, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(n, /proxy_set_header Connection "upgrade";/);
  assert.match(n, /proxy_buffering off;/);
  assert.match(n, /proxy_read_timeout 3m;/);
  assert.match(n, /client_max_body_size 8k;/);
  assert.match(n, /listen 80;/);
  assert.match(n, /acme-challenge/);
});
