import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import * as stream from 'stream';

/** Query parameter carrying the token on the first request; a cookie carries it after that. */
export const TOKEN_PARAM = 'token';

/**
 * HTML files at least this large get a loading page when the browser navigates
 * to them. Over a forwarded port a large self-contained page (inlined images)
 * can take minutes to arrive, and the browser shows a blank tab until then.
 */
export const LOADER_MIN_BYTES = 5 * 1024 * 1024;

/**
 * Downloads the page with `fetch` (not a navigation, so it gets the file
 * itself) while showing progress, then replaces itself with the result.
 * Writing into this document keeps the URL, so relative links resolve as if
 * the file had been loaded directly.
 */
const LOADER_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Loading…</title>
<style>
body { font: 15px system-ui, sans-serif; color: #333; max-width: 36em; margin: 30vh auto 0; }
progress { width: 100%; }
</style>
</head>
<body>
<p id="msg">Loading…</p>
<progress id="bar"></progress>
<script>
(async () => {
  const msg = document.getElementById('msg');
  const bar = document.getElementById('bar');
  const name = decodeURIComponent(location.pathname.split('/').pop());
  const mb = (n) => (n / 1048576).toFixed(1);
  // A dropped forward can leave the socket open with no data and no error.
  const abort = new AbortController();
  let stall;
  const watch = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(new Error('no data received for 60 s')), 60000);
  };
  try {
    watch();
    const res = await fetch(location.href, { signal: abort.signal });
    if (!res.ok) throw new Error((await res.text()) || 'HTTP ' + res.status);
    const total = Number(res.headers.get('content-length'));
    if (total) bar.max = total;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      watch();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) bar.value = received;
      msg.textContent =
        'Loading ' + name + ': ' + mb(received) + (total ? ' of ' + mb(total) : '') + ' MB';
    }
    clearTimeout(stall);
    if (total && received !== total) {
      throw new Error('got ' + mb(received) + ' of ' + mb(total) + ' MB; the file may have changed');
    }
    const html = await new Blob(chunks).text();
    document.open();
    document.write(html);
    document.close();
  } catch (err) {
    clearTimeout(stall);
    bar.remove();
    msg.textContent =
      'Could not load ' + name + ' (' + err.message + '). Run Open in Local Browser again in VS Code.';
  }
})();
</script>
</body>
</html>
`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
};

export interface StaticServer {
  readonly root: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

/**
 * Serves the files under `root` on 127.0.0.1 at an OS-assigned port.
 *
 * Other users on a shared host can connect to a loopback port, so every
 * request must present the random token, either as `?token=` or as the
 * cookie set when the query form succeeds. The cookie lets relative and
 * root-relative links (`/css/site.css`) load without the query string.
 */
export async function startStaticServer(root: string): Promise<StaticServer> {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  // Cookies are scoped by host, not port, so each server needs its own name.
  const cookieName = `oilb-${port}`;
  server.on('request', (req, res) => serve(root, token, cookieName, req, res));
  return {
    root,
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function serve(
  root: string,
  token: string,
  cookieName: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const queryOk = sameToken(url.searchParams.get(TOKEN_PARAM), token);
  if (!queryOk && !sameToken(readCookie(req.headers.cookie, cookieName), token)) {
    return end(res, 403, 'Forbidden: open this page from VS Code.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return end(res, 405, 'Method not allowed');
  }

  let file: string | undefined;
  try {
    file = resolveInside(root, decodeURIComponent(url.pathname));
  } catch {
    return end(res, 400, 'Bad request');
  }
  if (!file) {
    return end(res, 404, 'Not found');
  }

  statFile(file).then((found) => {
    if (!found) {
      return end(res, 404, 'Not found');
    }
    const ext = path.extname(found.file).toLowerCase();
    const loader =
      (ext === '.html' || ext === '.htm') &&
      found.size >= LOADER_MIN_BYTES &&
      // Only navigations: fetch(), curl and the loader itself get the file.
      ['document', 'iframe'].includes(String(req.headers['sec-fetch-dest']));
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': MIME_TYPES[loader ? '.html' : ext] ?? 'application/octet-stream',
      'Content-Length': loader ? Buffer.byteLength(LOADER_PAGE) : found.size,
      // Always re-read from disk, so a browser refresh shows the latest save.
      'Cache-Control': 'no-store',
    };
    if (queryOk) {
      headers['Set-Cookie'] = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (loader) {
      res.end(LOADER_PAGE);
      return;
    }
    // pipeline closes the file if the browser disconnects mid-download.
    stream.pipeline(fs.createReadStream(found.file), res, () => undefined);
  });
}

/** The regular file at `file`, or its `index.html` if it is a directory. */
async function statFile(file: string): Promise<{ file: string; size: number } | undefined> {
  try {
    let stat = await fs.promises.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.promises.stat(file);
    }
    return stat.isFile() ? { file, size: stat.size } : undefined;
  } catch {
    return undefined;
  }
}

/** The absolute path for `urlPath` under `root`, or undefined if it escapes `root`. */
function resolveInside(root: string, urlPath: string): string | undefined {
  if (urlPath.includes('\0')) {
    return undefined;
  }
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + urlPath));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined;
}

function sameToken(candidate: string | null | undefined, token: string): boolean {
  if (!candidate || candidate.length !== token.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function end(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}
