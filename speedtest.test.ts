import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { measureDownload, parseUrl } from './speedtest.ts';

async function serve(t: TestContext, handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new URL(`http://127.0.0.1:${address.port}`);
}

test('reads all chunks and performs exactly ten sequential requests', async t => {
  let requests = 0;
  let active = 0;
  let maximumActive = 0;
  const url = await serve(t, (request, response) => {
    requests++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    assert.equal(request.headers['accept-encoding'], 'identity');
    response.write(Buffer.alloc(17));
    setTimeout(() => {
      active--;
      response.end(Buffer.alloc(23));
    }, 10);
  });
  const result = await measureDownload(url);
  assert.equal(requests, 10);
  assert.equal(maximumActive, 1);
  assert.equal(result.totalBytes, 400);
  assert.ok(result.totalSeconds >= 0.09, 'timing must include delayed body chunks');
  assert.equal(result.averageSeconds, result.totalSeconds / 10);
  assert.equal(result.megabytesPerSecond, 400 / result.totalSeconds / 1_000_000);
});

test('stops on HTTP errors without retrying', async t => {
  let requests = 0;
  const url = await serve(t, (_request, response) => {
    requests++;
    response.writeHead(503).end('Unavailable');
  });
  await assert.rejects(measureDownload(url), /Request 1\/10 failed: HTTP 503/);
  assert.equal(requests, 1);
});

test('timeout covers stalled response bodies', async t => {
  const url = await serve(t, (_request, response) => {
    response.write('unfinished');
  });
  await assert.rejects(measureDownload(url, 100), /Timed out after 0.1 seconds/);
});

test('rejects interrupted downloads', async t => {
  const url = await serve(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': '1000' });
    response.write('short');
    setTimeout(() => response.destroy(), 10);
  });
  await assert.rejects(measureDownload(url), /Request 1\/10 failed/);
});

test('rejects compression that would distort byte counts', async t => {
  const url = await serve(t, (_request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip' });
    response.flushHeaders();
  });
  await assert.rejects(measureDownload(url), /Server ignored identity encoding/);
});

test('validates URL schemes', () => {
  assert.throws(() => parseUrl('file:///tmp/test'), /HTTP or HTTPS/);
  assert.throws(() => parseUrl('not a URL'));
  assert.equal(parseUrl('https://example.com').hostname, 'example.com');
});

async function cli(args: string[]) {
  const child = spawn(process.execPath, ['speedtest.ts', ...args], {
    cwd: import.meta.dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('CLI prints measurement units and exits successfully', async t => {
  const url = await serve(t, (_request, response) => response.end('hello'));
  const result = await cli([url.href]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Completed requests: 10/);
  assert.match(result.stdout, /Downloaded: 50 bytes/);
  assert.match(result.stdout, /Download speed: [\d.]+ MB\/s/);
});

test('CLI reports invalid input and HTTP errors with nonzero exit codes', async t => {
  for (const args of [['https://example.com', 'https://example.org'], ['file:///tmp/test'], ['https://example.com', '--timeout', 'NaN']]) {
    const result = await cli(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Error:/);
    assert.equal(result.stdout, '');
  }
  const url = await serve(t, (_request, response) => response.writeHead(404).end());
  const result = await cli([url.href]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 404/);
  assert.equal(result.stdout, '');
});
