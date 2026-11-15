// The MCP endpoint (POST /mcp): the 2026-07-28 "modern" era the suite negotiates first, over plain
// JSON (no SSE). One JSON-RPC request per POST, answered by one JSON body. `server/discover` is the
// mandatory first RPC; the client never falls back to the legacy initialize handshake when it works, but
// `initialize` is answered too, for completeness. Authentication is decided before any dispatch (401 for
// a missing or wrong token, including for `server/discover`); a body that is not JSON is HTTP 400 with
// JSON-RPC -32700; an unknown tool is -32601; a call missing a required argument is -32602.
//
// The six tools are the github-mcp-server canonical names, and their inputSchemas require only the
// properties the suite can fill — a required property the suite has no value for would fail the check
// with the property named. `tools/list` returns one module-level constant, so two answers serialize
// byte-identically. Tool results carry both a JSON text block (the checks read titles, names and numbers
// out of the text) and structuredContent (the checks read numbers out of it first).

import { Store } from './store.ts';
import { VIEWER } from './scenario.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28']);

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly McpToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Filter by state: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch (the branch with the changes).' }),
        base: Object.freeze({ type: 'string', description: 'The base branch (the branch the changes go into).' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

const TOOLS_BY_NAME = new Map<string, McpToolDef>(TOOLS.map((tool) => [tool.name, tool]));

type JsonRpcId = string | number | null;

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface McpHttpResponse {
  readonly status: number;
  /** null means "no body" (a notification's 202). */
  readonly body: unknown;
}

function success(id: JsonRpcId, result: unknown): McpHttpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: JsonRpcId, status: number, error: JsonRpcErrorBody): McpHttpResponse {
  return { status, body: { jsonrpc: '2.0', id, error } };
}

function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/** A tool result: the same JSON as a text block and as structuredContent. */
function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoJson(store: Store, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

type ToolOutcome =
  | { result: Record<string, unknown> }
  | { kind: 'rpcError'; error: JsonRpcErrorBody };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) {
    return { kind: 'rpcError', error: { code: -32601, message: `Method not found: no tool named ${name}` } };
  }
  const missing = tool.inputSchema.required.filter((property) => args[property] === undefined || args[property] === null);
  if (missing.length > 0) {
    return {
      kind: 'rpcError',
      error: { code: -32602, message: `Invalid params: missing required argument(s): ${missing.join(', ')}` },
    };
  }

  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  if (name === 'create_repo') {
    const repoNameArg = args.name;
    if (typeof repoNameArg !== 'string' || repoNameArg.trim() === '') {
      return { result: toolError('name must be a non-empty string') };
    }
    if (store.getRepo(VIEWER.login, repoNameArg) !== undefined) {
      return { result: toolError(`Repository ${VIEWER.login}/${repoNameArg} already exists`) };
    }
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(VIEWER.login, repoNameArg, description, isPrivate);
    return { result: toolResult(repoJson(store, VIEWER.login, repo.name)) };
  }

  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { result: toolError(`Repository ${owner}/${repoName} not found`) };
  }

  if (name === 'get_repo') {
    return { result: toolResult(repoJson(store, owner, repoName)) };
  }

  if (name === 'create_issue') {
    const title = args.title;
    if (typeof title !== 'string' || title.trim() === '') {
      return { result: toolError('title must be a non-empty string') };
    }
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return {
      result: toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        repository: { full_name: `${repo.owner}/${repo.name}` },
      }),
    };
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const issues = repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(issues) }],
        structuredContent: { issues },
      },
    };
  }

  if (name === 'create_pull_request') {
    const title = args.title;
    const head = args.head;
    const base = args.base;
    if (typeof title !== 'string' || title.trim() === '') return { result: toolError('title must be a non-empty string') };
    if (typeof head !== 'string' || typeof base !== 'string') return { result: toolError('head and base must be strings') };
    if (store.branchTip(repo, head) === undefined) return { result: toolError(`head branch ${head} does not exist`) };
    if (store.branchTip(repo, base) === undefined) return { result: toolError(`base branch ${base} does not exist`) };
    if (store.openPullForHead(repo, head, base) !== undefined) {
      return { result: toolError('A pull request already exists for this head and base') };
    }
    const body = typeof args.body === 'string' ? args.body : '';
    const pull = store.createPullRequest(repo, title, body, head, base);
    if (pull === null) return { result: toolError('could not create the pull request') };
    return {
      result: toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: { ref: pull.headRef },
        base: { ref: pull.baseRef },
      }),
    };
  }

  // merge_pull_request
  const pullNumber = args.pull_number;
  if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
    return { result: toolError('pull_number must be an integer') };
  }
  const pull = store.getPull(repo, pullNumber);
  if (pull === undefined) return { result: toolError(`Pull request #${pullNumber} not found`) };
  if (pull.state !== 'open' || pull.merged) return { result: toolError(`Pull request #${pullNumber} is already merged or closed`) };
  if (store.pullConflicts(repo, pull)) return { result: toolError(`Pull request #${pullNumber} has a merge conflict`) };
  const sha = store.mergePullRequest(repo, pull);
  if (sha === null) return { result: toolError(`Pull request #${pullNumber} could not be merged`) };
  return {
    result: toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      state: pull.state,
      merged: true,
      merge_commit_sha: sha,
      head: { ref: pull.headRef },
      base: { ref: pull.baseRef },
    }),
  };
}

/**
 * POST /mcp. `rawBody` is the request body text; this handler parses it itself so a body that is not
 * JSON can be answered HTTP 400 with JSON-RPC -32700. Authentication comes before dispatch: a missing
 * or wrong token is HTTP 401 no matter what the body holds.
 */
export function handleMcp(
  store: Store,
  rawBody: string,
  token: string | null,
  validToken: string,
): McpHttpResponse {
  if (token === null || token !== validToken) {
    return rpcError(null, 401, { code: -32000, message: 'Unauthorized' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return rpcError(null, 400, { code: -32700, message: 'Parse error' });
  }

  if (!isRecord(parsed)) {
    return rpcError(null, 400, { code: -32600, message: 'Invalid Request' });
  }
  const method = parsed.method;
  if (typeof method !== 'string' || method === '') {
    return rpcError(null, 400, { code: -32600, message: 'Invalid Request' });
  }
  const id: JsonRpcId = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const isNotification = parsed.id === undefined;

  if (method === 'server/discover') {
    const result = {
      resultType: 'discover',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return isNotification ? { status: 202, body: null } : success(id, result);
  }

  if (method === 'initialize') {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const offered = params.protocolVersion;
    const negotiated =
      typeof offered === 'string' && (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(offered)
        ? offered
        : MCP_SUPPORTED_VERSIONS[0];
    const result = {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    };
    return isNotification ? { status: 202, body: null } : success(id, result);
  }

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (isNotification) {
    // A notification for any other method: acknowledged, never answered.
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    return success(id, {});
  }

  if (method === 'tools/list') {
    return success(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return rpcError(id, 200, { code: -32602, message: 'Invalid params: tools/call needs a tool name' });
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(store, toolName, args);
    if ('kind' in outcome) {
      return rpcError(id, 200, outcome.error);
    }
    return success(id, outcome.result);
  }

  return rpcError(id, 200, { code: -32601, message: `Method not found: ${method}` });
}
