// The REST v3 surface (/api/v3). Every reply is application/json (never HTML) with a
// non-empty X-GitHub-Request-Id, including 401/404/422 errors; a missing or wrong bearer
// token is 401; a repository under another owner is 404, never 403; a duplicate repository
// create is 422 with "already exists" in the message.

import {
  countLines,
  diffFlat,
  flattenTree,
  isObjectId,
  parseCommit,
  parseTree,
  type TreeDiffEntry,
} from './gitcore.ts';
import {
  Store,
  viewerIdentity,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';

export interface RestRequest {
  readonly method: string;
  /** Path segments after /api/v3 (decoded). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** Parsed JSON body (undefined when there is no body). */
  readonly body: unknown;
  /** True when the body was present but not valid JSON. */
  readonly bodyParseError: boolean;
  /** The bearer token, or null when no Authorization header was sent. */
  readonly token: string | null;
  /** The request's origin, for absolute Link URLs (e.g. http://127.0.0.1:4123). */
  readonly baseUrl: string;
}

export interface RestResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** JSON body, or null for a bodyless reply (204). */
  readonly body: unknown;
}

let requestCounter = 0;

function requestId(): string {
  // A counter is enough: the suite only requires the header to be non-empty. No crypto call per
  // response keeps the read/write benchmark paths lean.
  requestCounter += 1;
  return `GH-${requestCounter.toString(36)}`;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestId(),
      ...extraHeaders,
    },
    body,
  };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function noContent(): RestResponse {
  return {
    status: 204,
    headers: { 'x-github-request-id': requestId() },
    body: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function bodyBoolean(body: unknown, field: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

function bodyStringArray(body: unknown, field: string): string[] | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

function userView(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    avatar_url: '',
    html_url: `https://github.com/${VIEWER.login}`,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullView(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorOf = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: '' };
    return {
      name: match[1],
      email: match[2],
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  const author = authorOf(commit.author);
  const committer = authorOf(commit.committer);
  // A git commit object conventionally ends its message with a newline; the API presents it
  // without the trailing newline (the suite compares the message exactly).
  const message = commit.message.replace(/\n+$/, '');
  return {
    sha,
    commit: {
      message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface PageParams {
  readonly page: number;
  readonly perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const page = Number.parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
  };
}

function paginate<T>(items: readonly T[], params: PageParams): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { page: items.slice(start, start + params.perPage), totalPages };
}

/** GitHub's Link header (absolute URLs, rel next/prev/first/last as applicable). */
function linkHeader(baseUrl: string, path: string, query: URLSearchParams, params: PageParams, totalPages: number): string | null {
  const links: string[] = [];
  const urlFor = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `${baseUrl}${path}?${q.toString()}`;
  };
  if (params.page < totalPages) {
    links.push(`<${urlFor(params.page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (params.page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(params.page - 1)}>; rel="prev"`);
  }
  return links.length > 0 ? links.join(', ') : null;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/** Handle one REST request. `validToken` is the bearer token the env gave this entry. */
export function handleRest(store: Store, req: RestRequest, validToken: string): RestResponse {
  // Auth first: every /api/v3 route needs the exact token.
  if (req.token === null || req.token !== validToken) {
    return err(401, 'Bad credentials');
  }
  if (req.bodyParseError) {
    return err(400, 'Problems parsing JSON');
  }
  const seg = req.segments;
  const method = req.method;

  // GET /api/v3/
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(
      200,
      {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, userView());
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') return createUserRepo(store, req);
    if (method === 'GET') return listUserRepos(store, req);
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    return handleRepoRoute(store, req, seg[1], seg[2], seg.slice(3));
  }

  return err(404, 'Not Found');
}

function createUserRepo(store: Store, req: RestRequest): RestResponse {
  const name = bodyString(req.body, 'name');
  if (name === undefined || name === '') return err(422, 'name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'name is invalid');
  const owner = VIEWER.login;
  if (store.getRepo(owner, name) !== undefined) {
    return err(422, `Repository ${owner}/${name} already exists`);
  }
  const description = bodyString(req.body, 'description') ?? '';
  const isPrivate = bodyBoolean(req.body, 'private') ?? false;
  const repo = store.createRepo(owner, name, description, isPrivate);
  return json(201, repoView(repo));
}

function listUserRepos(store: Store, req: RestRequest): RestResponse {
  const params = pageParams(req.query);
  const repos = store.listReposByOwner(VIEWER.login);
  const { page, totalPages } = paginate(repos, params);
  const link = linkHeader(req.baseUrl, '/api/v3/user/repos', req.query, params, totalPages);
  return json(
    200,
    page.map(repoView),
    link === null ? {} : { link },
  );
}

// ---------------------------------------------------------------------------------------------
// /repos/{owner}/{repo} routes
// ---------------------------------------------------------------------------------------------

function handleRepoRoute(
  store: Store,
  req: RestRequest,
  owner: string,
  repoName: string,
  rest: string[],
): RestResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return err(404, 'Not Found');
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo));
    if (method === 'PATCH') {
      const description = bodyString(req.body, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = bodyBoolean(req.body, 'private');
      if (isPrivate !== undefined) repo.private = isPrivate;
      repo.updatedAt = new Date().toISOString();
      return json(200, repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  const head = rest[0];
  if (head === 'branches') return handleBranches(store, req, repo, rest.slice(1));
  if (head === 'commits') return handleCommits(store, req, repo, rest.slice(1));
  if (head === 'contents') return handleContents(store, req, repo, rest.slice(1));
  if (head === 'git') return handleGitRefs(store, req, repo, rest.slice(1));
  if (head === 'labels') return handleLabels(store, req, repo, rest.slice(1));
  if (head === 'issues') return handleIssues(store, req, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(store, req, repo, rest.slice(1));
  return err(404, 'Not Found');
}

function handleBranches(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  if (req.method !== 'GET') return err(404, 'Not Found');
  if (rest.length === 0) {
    const branches = store.listBranches(repo).map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha },
    }));
    return json(200, branches);
  }
  const branch = rest.join('/');
  const sha = store.branchTip(repo, branch);
  if (sha === undefined) return err(404, 'Branch not found');
  const view = commitView(repo, sha);
  return json(200, { name: branch, commit: { sha, commit: view?.commit ?? { message: '' } } });
}

function handleCommits(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  if (req.method !== 'GET' || rest.length !== 0) return err(404, 'Not Found');
  const shas = store.listCommitShas(repo, req.query.get('sha') ?? undefined);
  const views: unknown[] = [];
  for (const sha of shas) {
    const view = commitView(repo, sha);
    if (view !== null) views.push(view);
  }
  return json(200, views);
}

function handleGitRefs(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  // POST /git/refs {ref, sha}
  if (rest.length === 1 && rest[0] === 'refs') {
    if (req.method !== 'POST') return err(404, 'Not Found');
    const ref = bodyString(req.body, 'ref');
    const sha = bodyString(req.body, 'sha');
    if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isObjectId(sha)) {
      return err(422, 'ref and sha are required');
    }
    if (!repo.objects.has(sha)) return err(422, 'sha does not exist');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    store.setRef(repo, ref, sha);
    return json(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  // GET /git/refs/heads/{branch}
  if (rest.length >= 2 && rest[0] === 'refs' && rest[1] === 'heads') {
    if (req.method !== 'GET') return err(404, 'Not Found');
    const branch = rest.slice(2).join('/');
    const sha = store.branchTip(repo, branch);
    if (sha === undefined) return err(404, 'Reference does not exist');
    return json(200, {
      ref: `refs/heads/${branch}`,
      object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
    });
  }
  return err(404, 'Not Found');
}

function handleLabels(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  if (req.method !== 'POST' || rest.length !== 0) return err(404, 'Not Found');
  const name = bodyString(req.body, 'name');
  if (name === undefined || name === '') return err(422, 'name is required');
  const color = bodyString(req.body, 'color') ?? 'ededed';
  const existing = repo.labels.get(name);
  if (existing !== undefined) return json(201, { name: existing.name, color: existing.color });
  repo.labels.set(name, { name, color });
  return json(201, { name, color });
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  const path = rest.join('/');
  const ref = req.query.get('ref') ?? undefined;
  if (req.method === 'GET') return getContents(store, repo, path, ref);
  if (req.method === 'PUT') return putContents(store, req, repo, path);
  if (req.method === 'DELETE') return deleteContents(store, req, repo, path);
  return err(404, 'Not Found');
}

function getContents(store: Store, repo: Repo, path: string, ref: string | undefined): RestResponse {
  const tip = store.resolveRef(repo, ref);
  if (tip === undefined) return err(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
  const treeOid = parseCommit(commit.data).tree;
  const files = flattenTree(treeOid, (oid) => repo.objects.get(oid));
  if (path === '') {
    // The repository root as a directory listing.
    return json(200, listDirectory(repo, treeOid, ''));
  }
  const file = files.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    if (!blob) return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
      sha: file.oid,
      content: blob.data.toString('base64'),
    });
  }
  // A directory? Find the subtree at this path.
  const dirOid = findSubtree(repo, treeOid, path);
  if (dirOid !== null) return json(200, listDirectory(repo, dirOid, path));
  return err(404, 'Not Found');
}

function findSubtree(repo: Repo, treeOid: string, path: string): string | null {
  let current = treeOid;
  for (const segment of path.split('/')) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function listDirectory(repo: Repo, treeOid: string, prefix: string): unknown[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const out: unknown[] = [];
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob?.data.length ?? 0,
      });
    }
  }
  return out;
}

function putContents(store: Store, req: RestRequest, repo: Repo, path: string): RestResponse {
  const contentB64 = bodyString(req.body, 'content');
  if (contentB64 === undefined) return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const message = bodyString(req.body, 'message') ?? `Update ${path}`;
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const sha = bodyString(req.body, 'sha');
  const files = store.branchFiles(repo, branch);
  const existing = files.get(path);
  if (existing !== undefined) {
    if (sha === undefined || sha.toLowerCase() !== existing.oid) {
      return err(409, 'sha does not match the current blob');
    }
  }
  const { blobOid, commitOid, created } = store.writeFile(repo, branch, path, content, message);
  return json(created ? 201 : 200, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      type: 'file',
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(store: Store, req: RestRequest, repo: Repo, path: string): RestResponse {
  const sha = bodyString(req.body, 'sha');
  const message = bodyString(req.body, 'message') ?? `Delete ${path}`;
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const files = store.branchFiles(repo, branch);
  const existing = files.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  if (sha !== undefined && sha.toLowerCase() !== existing.oid) {
    return err(409, 'sha does not match the current blob');
  }
  const commitOid = store.deleteFile(repo, branch, path, message);
  if (commitOid === null) return err(404, 'Not Found');
  return json(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') return createIssue(store, req, repo);
    if (req.method === 'GET') return listIssues(store, req, repo);
    return err(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const issue = store.getIssue(repo, number);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      if (issue === undefined) return err(404, 'Not Found');
      return json(200, issueView(repo, issue));
    }
    if (req.method === 'PATCH') {
      if (issue === undefined) return err(404, 'Not Found');
      const state = bodyString(req.body, 'state');
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') return err(422, 'state must be open or closed');
        issue.state = state;
      }
      const title = bodyString(req.body, 'title');
      if (title !== undefined) issue.title = title;
      const body = bodyString(req.body, 'body');
      if (body !== undefined) issue.body = body;
      const labels = bodyStringArray(req.body, 'labels');
      if (labels !== undefined) {
        for (const name of labels) {
          if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
        }
        issue.labels = [...labels];
      }
      issue.updatedAt = new Date().toISOString();
      return json(200, issueView(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return err(404, 'Not Found');
    if (req.method === 'GET') {
      const comments = (repo.comments.get(number) ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      }));
      return json(200, comments);
    }
    if (req.method === 'POST') {
      const body = bodyString(req.body, 'body');
      if (body === undefined || body === '') return err(422, 'body is required');
      const comment = store.addComment(repo, number, body);
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      });
    }
  }
  return err(404, 'Not Found');
}

function createIssue(store: Store, req: RestRequest, repo: Repo): RestResponse {
  const title = bodyString(req.body, 'title');
  if (title === undefined || title === '') return err(422, 'title is required');
  const body = bodyString(req.body, 'body') ?? '';
  const labels = bodyStringArray(req.body, 'labels') ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
  }
  const issue = store.createIssue(repo, title, body, labels);
  return json(201, issueView(repo, issue));
}

function listIssues(store: Store, req: RestRequest, repo: Repo): RestResponse {
  const state = (req.query.get('state') ?? 'open').toLowerCase();
  const direction = (req.query.get('direction') ?? 'desc').toLowerCase();
  let issues = repo.issues.slice();
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') return err(422, 'state must be open, closed or all');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const params = pageParams(req.query);
  const { page, totalPages } = paginate(issues, params);
  const link = linkHeader(req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, req.query, params, totalPages);
  return json(
    200,
    page.map((issue) => issueView(repo, issue)),
    link === null ? {} : { link },
  );
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') return createPull(store, req, repo);
    if (req.method === 'GET') return listPulls(store, req, repo);
    return err(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const pull = store.getPull(repo, number);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      if (pull === undefined) return err(404, 'Not Found');
      return json(200, pullView(store, repo, pull));
    }
    return err(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (req.method !== 'GET') return err(404, 'Not Found');
    if (pull === undefined) return err(404, 'Not Found');
    return json(200, pullFilesView(store, repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (req.method !== 'PUT') return err(404, 'Not Found');
    if (pull === undefined) return err(404, 'Not Found');
    if (pull.state !== 'open' || pull.merged) return err(405, 'Pull request is already merged or closed');
    if (store.pullConflicts(repo, pull)) return err(405, 'Merge conflict');
    const sha = store.mergePullRequest(repo, pull);
    if (sha === null) return err(405, 'Merge conflict');
    return json(200, { merged: true, sha, message: `Pull request #${pull.number} merged` });
  }
  return err(404, 'Not Found');
}

function createPull(store: Store, req: RestRequest, repo: Repo): RestResponse {
  const title = bodyString(req.body, 'title');
  const head = bodyString(req.body, 'head');
  const base = bodyString(req.body, 'base');
  if (title === undefined || title === '') return err(422, 'title is required');
  if (head === undefined || head === '') return err(422, 'head is required');
  if (base === undefined || base === '') return err(422, 'base is required');
  if (head === base) return err(422, 'head and base must differ');
  if (store.branchTip(repo, head) === undefined) return err(422, `head branch ${head} does not exist`);
  if (store.branchTip(repo, base) === undefined) return err(422, `base branch ${base} does not exist`);
  if (store.openPullForHead(repo, head, base) !== undefined) {
    return err(422, 'A pull request already exists for this head and base');
  }
  const body = bodyString(req.body, 'body') ?? '';
  const pull = store.createPullRequest(repo, title, body, head, base);
  if (pull === null) return err(422, 'could not create the pull request');
  return json(201, pullView(store, repo, pull));
}

function listPulls(store: Store, req: RestRequest, repo: Repo): RestResponse {
  const state = (req.query.get('state') ?? 'open').toLowerCase();
  let pulls = repo.pulls.slice();
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') return err(422, 'state must be open, closed or all');
  pulls.sort((a, b) => b.number - a.number);
  const params = pageParams(req.query);
  const { page, totalPages } = paginate(pulls, params);
  const link = linkHeader(req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, req.query, params, totalPages);
  return json(
    200,
    page.map((pull) => pullView(store, repo, pull)),
    link === null ? {} : { link },
  );
}

/** The changed files of a pull request, with line counts for the files shape. */
function pullFilesView(store: Store, repo: Repo, pull: PullRequest): unknown[] {
  const diff = store.pullFiles(repo, pull);
  return diff.map((entry) => {
    const counts = fileLineCounts(repo, entry);
    return {
      filename: entry.path,
      status: entry.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
}

function fileLineCounts(repo: Repo, entry: TreeDiffEntry): { additions: number; deletions: number } {
  const oldData = entry.oldOid === null ? null : repo.objects.get(entry.oldOid)?.data ?? null;
  const newData = entry.newOid === null ? null : repo.objects.get(entry.newOid)?.data ?? null;
  if (oldData === null && newData !== null) return { additions: countLines(newData), deletions: 0 };
  if (newData === null && oldData !== null) return { additions: 0, deletions: countLines(oldData) };
  if (oldData === null || newData === null) return { additions: 0, deletions: 0 };
  const linesOf = (data: Buffer): string[] => {
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(oldData);
  const newLines = linesOf(newData);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let additions = 0;
  let deletions = 0;
  for (const line of newLines) if (!oldSet.has(line)) additions += 1;
  for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
  // A changed file whose lines merely reordered still changed: never report 0/0 for a modification.
  if (additions === 0 && deletions === 0 && entry.oldOid !== entry.newOid) {
    additions = 1;
    deletions = 1;
  }
  return { additions, deletions };
}

// Re-exported for the GraphQL and MCP surfaces, which share these views.
export { issueView, pullView, repoView, userView };
export { viewerIdentity };
