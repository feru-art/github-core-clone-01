// The HTTP router: one node:http server over one shared Store, dispatching to the four surfaces.
//   GET  /healthz                       the boot probe: 200 {"ok": true}
//   /api/v3/*                           REST v3 (handleRest)
//   POST /api/graphql                   GraphQL (handleGraphQL)
//   POST /mcp                           MCP, Streamable HTTP, plain JSON (handleMcp)
//   /{owner}/{repo}.git/info/refs       smart-HTTP advertisement (v0/v2)
//   /{owner}/{repo}.git/git-upload-pack smart-HTTP fetch (v0/v2)
//   /{owner}/{repo}.git/git-receive-pack smart-HTTP push (v0)
//
// The bearer token is MAKEFUN_SHOP_TOKEN ('dev-token' when unset, for local runs). REST, GraphQL and
// MCP refuse a missing or wrong token with 401 before dispatching; the git surface is not auth-tested
// by the suite, so it serves any caller that knows the repo path. A malformed body never crashes the
// server: each surface answers its own error shape (REST 400, GraphQL 400, MCP 400/-32700, git 400).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'dev-token';

/** Read the request body whole (the suite's bodies are small: packs stay under a few MB). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1];
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8').toString(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length.toString() });
  res.end(body);
}

/** The request's origin, for absolute Link URLs (the REST surface needs it). */
function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(store: Store = new Store()): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        // Manual split instead of `new URL(...)`: the router only needs the pathname and, for
        // REST/git, the raw query string. One less object per request on the hot paths.
        const rawUrl = req.url ?? '/';
        const queryIndex = rawUrl.indexOf('?');
        const path = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
        const queryString = queryIndex < 0 ? '' : rawUrl.slice(queryIndex + 1);
        const method = (req.method ?? 'GET').toUpperCase();

        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { data: null, errors: [{ message: 'Method not allowed' }] });
            return;
          }
          const raw = await readBody(req);
          const text = raw.toString('utf8');
          let body: unknown = null;
          let bodyParseError = false;
          if (text.trim() !== '') {
            try {
              body = JSON.parse(text) as unknown;
            } catch {
              bodyParseError = true;
            }
          }
          const answer = handleGraphQL(store, body, bodyParseError, bearerToken(req), TOKEN);
          sendJson(res, answer.status, answer.body);
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
            return;
          }
          const raw = await readBody(req);
          const answer = handleMcp(store, raw.toString('utf8'), bearerToken(req), TOKEN);
          if (answer.body === null) {
            res.writeHead(answer.status);
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const rest = path.slice('/api/v3'.length);
          const segments = rest
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => {
              try {
                return decodeURIComponent(segment);
              } catch {
                return segment;
              }
            });
          let body: unknown;
          let bodyParseError = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            const text = raw.toString('utf8');
            if (text.trim() !== '') {
              try {
                body = JSON.parse(text) as unknown;
              } catch {
                bodyParseError = true;
              }
            }
          }
          const request: RestRequest = {
            method,
            segments,
            query: new URLSearchParams(queryString),
            body,
            bodyParseError,
            token: bearerToken(req),
            baseUrl: baseUrlOf(req),
          };
          const answer = handleRest(store, request, TOKEN);
          if (answer.body === null) {
            res.writeHead(answer.status, answer.headers);
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, answer.headers);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const endpoint = gitMatch[3];
          if (endpoint === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method not allowed' });
              return;
            }
            const gitProtocol = req.headers['git-protocol'];
            const answer = handleInfoRefs(
              store,
              owner,
              repoName,
              new URLSearchParams(queryString).get('service'),
              Array.isArray(gitProtocol) ? gitProtocol.join(',') : gitProtocol,
            );
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method not allowed' });
            return;
          }
          const raw = await readBody(req);
          const answer =
            endpoint === 'git-upload-pack'
              ? handleUploadPack(store, owner, repoName, raw)
              : handleReceivePack(store, owner, repoName, raw);
          sendBuffer(res, answer.status, answer.contentType, answer.body);
          return;
        }

        notFound(res);
      } catch (err) {
        // A handler must never take the server down: answer 500 JSON and keep serving.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal server error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
