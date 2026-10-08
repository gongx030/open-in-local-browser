import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { StaticServer, TOKEN_PARAM, startStaticServer } from '../staticServer';

let dir: string;
let server: StaticServer;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oilb-'));
  fs.mkdirSync(path.join(dir, 'site', 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(dir, 'site', 'css', 'a.css'), 'h1{}');
  fs.writeFileSync(path.join(dir, 'site', 'doc.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  server = await startStaticServer(path.join(dir, 'site'));
});

after(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;

test('the query token grants a cookie that loads the page assets', async () => {
  const page = await fetch(`${base()}/index.html?${TOKEN_PARAM}=${server.token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(await page.text(), '<h1>hi</h1>');

  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  const css = await fetch(`${base()}/css/a.css`, { headers: { cookie } });
  assert.equal(css.status, 200);
  assert.equal(await css.text(), 'h1{}');
});

test('a PDF is served inline so the browser displays it', async () => {
  const res = await fetch(`${base()}/doc.pdf?${TOKEN_PARAM}=${server.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), null);
});

test('requests without the token are refused', async () => {
  assert.equal((await fetch(`${base()}/index.html`)).status, 403);
  assert.equal((await fetch(`${base()}/index.html?${TOKEN_PARAM}=wrong`)).status, 403);
});

test('paths outside the root are not served', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/css/..%2f..%2fsecret.txt']) {
    const res = await fetch(`${base()}${p}?${TOKEN_PARAM}=${server.token}`);
    assert.equal(res.status, 404, p);
  }
});
