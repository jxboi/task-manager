import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import signIn from '../api/auth/sign-in/email.js';
import signOut from '../api/auth/sign-out.js';
import signUp from '../api/auth/sign-up/email.js';
import session from '../api/session.js';
import todos from '../api/todos.js';

const origin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000');
if (origin.protocol !== 'http:' || origin.hostname !== 'localhost' || origin.href !== `${origin.origin}/`) {
  throw new Error('Use a localhost HTTP origin for the development server.');
}
process.env.BETTER_AUTH_URL = origin.origin;

const root = new URL('../', import.meta.url);
const handlers = new Map([
  ['/api/auth/sign-in/email', signIn],
  ['/api/auth/sign-out', signOut],
  ['/api/auth/sign-up/email', signUp],
  ['/api/session', session],
  ['/api/todos', todos],
]);

const staticTypes = new Map([['index.html', 'text/html'], ['styles.css', 'text/css']]);

async function serve(request, response) {
  const url = new URL(request.url, origin);
  const handler = handlers.get(url.pathname);
  if (handler) {
    const init = { method: request.method, headers: request.headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = Readable.toWeb(request);
      init.duplex = 'half';
    }
    const result = await handler.fetch(new Request(url, init));
    response.statusCode = result.status;
    for (const [key, value] of result.headers) {
      if (key !== 'set-cookie') response.setHeader(key, value);
    }
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('Set-Cookie', cookies);
    if (result.body) await pipeline(Readable.fromWeb(result.body), response);
    else response.end();
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const contentType = staticTypes.get(file) ?? (/^src\/[\w-]+\.js$/.test(file) ? 'text/javascript' : null);
  if (!contentType || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  const body = await readFile(new URL(file, root));
  response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
  response.end(request.method === 'HEAD' ? undefined : body);
}

createServer((request, response) => {
  serve(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Cache-Control': 'no-store' }).end();
  });
}).listen(Number(origin.port || 80), 'localhost', () => console.log(origin.origin));
