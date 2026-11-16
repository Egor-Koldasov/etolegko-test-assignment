import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://speed.cloudflare.com/__down?bytes=10000000';
const REQUEST_COUNT = 10;
const DEFAULT_TIMEOUT_SECONDS = 30;

export interface Measurement {
  totalBytes: number;
  totalSeconds: number;
  averageSeconds: number;
  megabytesPerSecond: number;
}

export function parseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not supported.');
  }
  return url;
}

export async function measureDownload(
  url: URL,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
): Promise<Measurement> {
  let totalBytes = 0;
  let totalSeconds = 0;

  for (let index = 0; index < REQUEST_COUNT; index++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();

    try {
      const response = await fetch(url, {
        headers: { 'Accept-Encoding': 'identity' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      // fetch transparently decompresses encoded bodies; reject these so the
      // byte count cannot accidentally describe decompressed data.
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') {
        throw new Error(`Server ignored identity encoding (received ${encoding}).`);
      }
      if (!response.body) {
        throw new Error('Response has no body.');
      }
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
      }
      totalSeconds += (performance.now() - started) / 1000;
      totalBytes += bytes;
    } catch (error) {
      const reason = controller.signal.aborted
        ? `Timed out after ${timeoutMs / 1000} seconds.`
        : error instanceof Error ? error.message : String(error);
      throw new Error(`Request ${index + 1}/${REQUEST_COUNT} failed: ${reason}`, { cause: error });
    } finally {
      clearTimeout(timeout);
      // Also release a response whose status or headers were rejected.
      controller.abort();
    }
  }

  return {
    totalBytes,
    totalSeconds,
    averageSeconds: totalSeconds / REQUEST_COUNT,
    megabytesPerSecond: totalSeconds > 0 ? totalBytes / totalSeconds / 1_000_000 : 0,
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log('Usage: node speedtest.ts [http(s)-url] [--timeout <seconds>]');
    console.log(`Default URL: ${DEFAULT_URL} (100 MB across 10 requests).`);
    console.log('Downloads the URL 10 times sequentially. Default per-request timeout: 30 seconds.');
    return;
  }
  if (positionals.length > 1) {
    throw new Error('Provide at most one URL. Run with --help for usage.');
  }
  const seconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647 || seconds * 1000 < 1) {
    throw new Error('Timeout must be between 0.001 and 2147483.647 seconds.');
  }
  const result = await measureDownload(parseUrl(positionals[0] ?? DEFAULT_URL), Math.ceil(seconds * 1000));
  console.log(`Completed requests: ${REQUEST_COUNT}`);
  console.log(`Average request time: ${result.averageSeconds.toFixed(3)} s`);
  console.log(`Downloaded: ${result.totalBytes} bytes (${(result.totalBytes / 1_000_000).toFixed(3)} MB)`);
  console.log(`Download speed: ${result.megabytesPerSecond.toFixed(3)} MB/s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
