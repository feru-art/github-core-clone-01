// A small GraphQL executor for the fixed documents the suite sends (checks-graphql.ts):
// viewer/repository/node/__type queries, issue and pull-request reads with connections and
// cursor pagination, and the five mutations. No GraphQL library: a hand-written lexer and
// parser for the query-language subset the documents use (operations, variables, aliases,
// arguments incl. input objects/enums/lists/null, inline fragments), plus a resolver table
// over the shared store. An unknown field is a 200 with an `errors` array naming the field.

import { Store, decodeGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, type Issue, type PullRequest, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind =
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | 'punct'
  | 'ellipsis';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!@=[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && isDigit(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.' && isDigit(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && isDigit(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && isDigit(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selections: SelectionNode[];
}

export interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new Error(`unsupported operation ${JSON.stringify(keyword)}`);
    }
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.next().value;
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.matchPunct('=')) defaultValue = this.parseValue();
        variables.push({ name: varName, defaultValue });
      }
    }
    return { kind: keyword, name, variables, selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      const token = this.peek();
      if (token !== undefined && token.kind === 'ellipsis') {
        this.next();
        let typeCondition: string | null = null;
        const on = this.peek();
        if (on !== undefined && on.kind === 'name' && on.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.matchPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      let selections2: SelectionNode[] = [];
      const brace = this.peek();
      if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
        selections2 = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', alias, name, args, selections: selections2 });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseDocument(source: string): OperationNode[] {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

class GraphQLError extends Error {}

type FieldResult =
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'object'; type: string; value: unknown }
  | { kind: 'list'; itemType: string; items: unknown[] };

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: ExecCtx) => FieldResult;

interface ExecCtx {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
}

function scalar(value: string | number | boolean | null): FieldResult {
  return { kind: 'scalar', value };
}

function obj(type: string, value: unknown): FieldResult {
  return { kind: 'object', type, value };
}

function list(itemType: string, items: unknown[]): FieldResult {
  return { kind: 'list', itemType, items };
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => evalValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = evalValue(arg.value, variables);
  return args;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

interface IssueRef {
  readonly repo: Repo;
  readonly issue: Issue;
}

interface PullRef {
  readonly repo: Repo;
  readonly pull: PullRequest;
}

function viewerUser(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveRepoByGlobalId(store: Store, id: unknown): Repo {
  if (typeof id !== 'string') throw new GraphQLError('repositoryId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') throw new GraphQLError('Could not resolve to a Repository with the id');
  const [owner, name] = decoded.key.split('/');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id');
  return repo;
}

function resolveIssueByGlobalId(store: Store, id: unknown): IssueRef {
  if (typeof id !== 'string') throw new GraphQLError('issueId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') throw new GraphQLError('Could not resolve to an Issue with the id');
  const hash = decoded.key.lastIndexOf('#');
  const ownerRepo = decoded.key.slice(0, hash);
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  const [owner, name] = ownerRepo.split('/');
  const repo = store.getRepo(owner, name);
  const issue = repo === undefined ? undefined : store.getIssue(repo, number);
  if (repo === undefined || issue === undefined) throw new GraphQLError('Could not resolve to an Issue with the id');
  return { repo, issue };
}

function resolvePullByGlobalId(store: Store, id: unknown): PullRef {
  if (typeof id !== 'string') throw new GraphQLError('pullRequestId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') throw new GraphQLError('Could not resolve to a PullRequest with the id');
  const hash = decoded.key.lastIndexOf('#');
  const ownerRepo = decoded.key.slice(0, hash);
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  const [owner, name] = ownerRepo.split('/');
  const repo = store.getRepo(owner, name);
  const pull = repo === undefined ? undefined : store.getPull(repo, number);
  if (repo === undefined || pull === undefined) throw new GraphQLError('Could not resolve to a PullRequest with the id');
  return { repo, pull };
}

interface IssueConnectionValue {
  readonly nodes: IssueRef[];
  readonly pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): IssueConnectionValue {
  let issues = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy;
  const direction =
    typeof orderBy === 'object' && orderBy !== null ? (orderBy as Record<string, unknown>).direction : undefined;
  if (direction === 'DESC') issues.sort((a, b) => b.number - a.number);
  else issues.sort((a, b) => a.number - b.number);
  const after = args.after;
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const n = decodeCursor(after);
    if (n !== null) {
      const idx = issues.findIndex((issue) => issue.number === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(start, start + Math.max(0, first));
  return {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: {
      hasNextPage: start + page.length < issues.length,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
    },
  };
}

// The introspection surface gh feature-detects.
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
};
const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const FIELDS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => obj('User', viewerUser()),
    repository: (_parent, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return scalar(null);
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? scalar(null) : obj('Repository', repo);
    },
    node: (_parent, args, ctx) => {
      const id = args.id;
      if (typeof id !== 'string') return scalar(null);
      const decoded = decodeGlobalId(id);
      if (decoded === null) return scalar(null);
      if (decoded.type === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? scalar(null) : obj('Repository', repo);
      }
      if (decoded.type === 'Issue') {
        try {
          const ref = resolveIssueByGlobalId(ctx.store, id);
          return obj('Issue', ref);
        } catch {
          return scalar(null);
        }
      }
      if (decoded.type === 'PullRequest') {
        try {
          const ref = resolvePullByGlobalId(ctx.store, id);
          return obj('PullRequest', ref);
        } catch {
          return scalar(null);
        }
      }
      return scalar(null);
    },
    __type: (_parent, args) => {
      const name = args.name;
      if (typeof name !== 'string') return scalar(null);
      if (TYPE_FIELDS[name] === undefined && TYPE_ENUM_VALUES[name] === undefined) return scalar(null);
      return obj('__Type', { name });
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = args.input as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object') throw new GraphQLError('createIssue needs an input object');
      const repo = resolveRepoByGlobalId(ctx.store, input.repositoryId);
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new GraphQLError('title is required');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, title, body, []);
      return obj('CreateIssuePayload', { issue: { repo, issue } });
    },
    closeIssue: (_parent, args, ctx) => {
      const input = args.input as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object') throw new GraphQLError('closeIssue needs an input object');
      const ref = resolveIssueByGlobalId(ctx.store, input.issueId);
      ref.issue.state = 'closed';
      ref.issue.updatedAt = new Date().toISOString();
      return obj('CloseIssuePayload', { issue: ref });
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = args.input as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object') throw new GraphQLError('createPullRequest needs an input object');
      const repo = resolveRepoByGlobalId(ctx.store, input.repositoryId);
      const title = input.title;
      const head = input.headRefName;
      const base = input.baseRefName;
      if (typeof title !== 'string' || title === '') throw new GraphQLError('title is required');
      if (typeof head !== 'string' || typeof base !== 'string') throw new GraphQLError('headRefName and baseRefName are required');
      if (ctx.store.branchTip(repo, head) === undefined) throw new GraphQLError(`head branch ${head} does not exist`);
      if (ctx.store.branchTip(repo, base) === undefined) throw new GraphQLError(`base branch ${base} does not exist`);
      if (ctx.store.openPullForHead(repo, head, base) !== undefined) {
        throw new GraphQLError('A pull request already exists for this head and base');
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = ctx.store.createPullRequest(repo, title, body, head, base);
      if (pull === null) throw new GraphQLError('could not create the pull request');
      return obj('CreatePullRequestPayload', { pullRequest: { repo, pull } });
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = args.input as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object') throw new GraphQLError('mergePullRequest needs an input object');
      const ref = resolvePullByGlobalId(ctx.store, input.pullRequestId);
      if (ref.pull.state !== 'open' || ref.pull.merged) throw new GraphQLError('Pull request is already merged or closed');
      if (ctx.store.pullConflicts(ref.repo, ref.pull)) throw new GraphQLError('Merge conflict');
      const sha = ctx.store.mergePullRequest(ref.repo, ref.pull);
      if (sha === null) throw new GraphQLError('Merge conflict');
      return obj('MergePullRequestPayload', { pullRequest: ref });
    },
    addComment: (_parent, args, ctx) => {
      const input = args.input as Record<string, unknown> | null;
      if (input === null || typeof input !== 'object') throw new GraphQLError('addComment needs an input object');
      const ref = resolveIssueByGlobalId(ctx.store, input.subjectId);
      const body = input.body;
      if (typeof body !== 'string' || body === '') throw new GraphQLError('body is required');
      const comment = ctx.store.addComment(ref.repo, ref.issue.number, body);
      return obj('AddCommentPayload', {
        commentEdge: { node: { id: `comment-${comment.id}`, body: comment.body } },
      });
    },
  },
  Repository: {
    id: (parent) => scalar(repoGlobalId(parent as Repo)),
    databaseId: (parent) => scalar((parent as Repo).id),
    name: (parent) => scalar((parent as Repo).name),
    nameWithOwner: (parent) => scalar(`${(parent as Repo).owner}/${(parent as Repo).name}`),
    owner: () => obj('User', viewerUser()),
    defaultBranchRef: (parent, _args, ctx) => {
      const repo = parent as Repo;
      const tip = ctx.store.branchTip(repo, repo.defaultBranch);
      return tip === undefined ? scalar(null) : obj('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => scalar('ADMIN'),
    hasIssuesEnabled: () => scalar(true),
    issue: (parent, args, ctx) => {
      const repo = parent as Repo;
      const number = args.number;
      if (typeof number !== 'number') return scalar(null);
      const issue = ctx.store.getIssue(repo, number);
      return issue === undefined ? scalar(null) : obj('Issue', { repo, issue });
    },
    issues: (parent, args) => obj('IssueConnection', issueConnection(parent as Repo, args)),
    pullRequests: (parent, args) => {
      const repo = parent as Repo;
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const pulls = repo.pulls.slice().sort((a, b) => b.number - a.number).slice(0, Math.max(0, first));
      return obj('PullRequestConnection', { nodes: pulls.map((pull) => ({ repo, pull })) });
    },
    pullRequest: (parent, args, ctx) => {
      const repo = parent as Repo;
      const number = args.number;
      if (typeof number !== 'number') return scalar(null);
      const pull = ctx.store.getPull(repo, number);
      return pull === undefined ? scalar(null) : obj('PullRequest', { repo, pull });
    },
  },
  User: {
    login: (parent) => scalar(String((parent as Record<string, unknown>).login ?? '')),
    id: (parent) => scalar(String((parent as Record<string, unknown>).id ?? '')),
    name: (parent) => scalar(String((parent as Record<string, unknown>).name ?? '')),
    email: (parent) => scalar(String((parent as Record<string, unknown>).email ?? '')),
  },
  Issue: {
    id: (parent) => scalar(issueGlobalId((parent as IssueRef).repo, (parent as IssueRef).issue.number)),
    number: (parent) => scalar((parent as IssueRef).issue.number),
    title: (parent) => scalar((parent as IssueRef).issue.title),
    state: (parent) => scalar(issueState((parent as IssueRef).issue)),
    body: (parent) => scalar((parent as IssueRef).issue.body),
  },
  IssueConnection: {
    nodes: (parent) => list('Issue', (parent as IssueConnectionValue).nodes),
    pageInfo: (parent) => obj('PageInfo', (parent as IssueConnectionValue).pageInfo),
  },
  PageInfo: {
    hasNextPage: (parent) => scalar((parent as { hasNextPage: boolean }).hasNextPage),
    endCursor: (parent) => scalar((parent as { endCursor: string | null }).endCursor),
    hasPreviousPage: () => scalar(false),
    startCursor: () => scalar(null),
  },
  PullRequest: {
    id: (parent) => scalar(pullGlobalId((parent as PullRef).repo, (parent as PullRef).pull.number)),
    number: (parent) => scalar((parent as PullRef).pull.number),
    title: (parent) => scalar((parent as PullRef).pull.title),
    body: (parent) => scalar((parent as PullRef).pull.body),
    state: (parent) => scalar(pullState((parent as PullRef).pull)),
    merged: (parent) => scalar((parent as PullRef).pull.merged),
    headRefName: (parent) => scalar((parent as PullRef).pull.headRef),
    baseRefName: (parent) => scalar((parent as PullRef).pull.baseRef),
    mergeable: (parent, _args, ctx) => {
      const ref = parent as PullRef;
      return scalar(ctx.store.pullConflicts(ref.repo, ref.pull) ? 'CONFLICTING' : 'MERGEABLE');
    },
    files: (parent, args, ctx) => {
      const ref = parent as PullRef;
      const first = typeof args.first === 'number' ? args.first : 100;
      const diff = ctx.store.pullFiles(ref.repo, ref.pull).slice(0, Math.max(0, first));
      return obj('PullRequestConnection', { nodes: diff.map((entry) => ({ path: entry.path })) });
    },
  },
  PullRequestConnection: {
    nodes: (parent, _args, ctx) => {
      const nodes = (parent as { nodes: unknown[] }).nodes;
      // Nodes are PullRefs (from pullRequests) or {path} (from files): tell them apart by shape.
      if (nodes.length > 0 && typeof nodes[0] === 'object' && nodes[0] !== null && 'pull' in (nodes[0] as Record<string, unknown>)) {
        return list('PullRequest', nodes);
      }
      return list('PullRequestChangedFile', nodes);
    },
  },
  PullRequestChangedFile: {
    path: (parent) => scalar(String((parent as { path: string }).path)),
  },
  Ref: {
    name: (parent) => scalar(String((parent as { name: string }).name)),
  },
  CreateIssuePayload: {
    issue: (parent) => obj('Issue', (parent as { issue: IssueRef }).issue),
  },
  CloseIssuePayload: {
    issue: (parent) => obj('Issue', (parent as { issue: IssueRef }).issue),
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => obj('PullRequest', (parent as { pullRequest: PullRef }).pullRequest),
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => obj('PullRequest', (parent as { pullRequest: PullRef }).pullRequest),
  },
  AddCommentPayload: {
    commentEdge: (parent) => obj('IssueCommentEdge', (parent as { commentEdge: unknown }).commentEdge),
  },
  IssueCommentEdge: {
    node: (parent) => obj('IssueComment', (parent as { node: unknown }).node),
  },
  IssueComment: {
    id: (parent) => scalar(String((parent as { id: string }).id)),
    body: (parent) => scalar(String((parent as { body: string }).body)),
  },
  __Type: {
    name: (parent) => scalar(String((parent as { name: string }).name)),
    fields: (parent) => {
      const name = (parent as { name: string }).name;
      return list('__Field', (TYPE_FIELDS[name] ?? []).map((field) => ({ name: field })));
    },
    enumValues: (parent) => {
      const name = (parent as { name: string }).name;
      return list('__EnumValue', (TYPE_ENUM_VALUES[name] ?? []).map((value) => ({ name: value })));
    },
  },
  __Field: {
    name: (parent) => scalar(String((parent as { name: string }).name)),
  },
  __EnumValue: {
    name: (parent) => scalar(String((parent as { name: string }).name)),
  },
};

function executeSelections(
  typeName: string,
  value: unknown,
  selections: readonly SelectionNode[],
  ctx: ExecCtx,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, value, selection.selections, ctx, errors));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolver = FIELDS[typeName]?.[selection.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    let result: FieldResult;
    try {
      result = resolver(value, evalArgs(selection, ctx.variables), ctx);
    } catch (err) {
      if (err instanceof GraphQLError) {
        errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (selection.selections.length === 0) {
      if (result.kind === 'scalar') out[key] = result.value;
      else {
        errors.push({ message: `Field "${selection.name}" of type "${typeName}" must have a selection of subfields.` });
        out[key] = null;
      }
      continue;
    }
    if (result.kind === 'scalar') {
      if (result.value === null) out[key] = null;
      else {
        errors.push({ message: `Field "${selection.name}" must not have a selection since type is a scalar.` });
        out[key] = null;
      }
      continue;
    }
    if (result.kind === 'object') {
      if (result.value === null || result.value === undefined) out[key] = null;
      else out[key] = executeSelections(result.type, result.value, selection.selections, ctx, errors);
      continue;
    }
    out[key] = result.items.map((item) => executeSelections(result.itemType, item, selection.selections, ctx, errors));
  }
  return out;
}

export interface GraphQLResult {
  readonly data: unknown;
  readonly errors?: Array<{ message: string }>;
}

function executeOperation(
  store: Store,
  operation: OperationNode,
  variables: Record<string, unknown>,
): GraphQLResult {
  const merged: Record<string, unknown> = { ...variables };
  for (const varDef of operation.variables) {
    if (!(varDef.name in merged) && varDef.defaultValue !== null) {
      merged[varDef.name] = evalValue(varDef.defaultValue, variables);
    }
  }
  const ctx: ExecCtx = { store, variables: merged };
  const errors: Array<{ message: string }> = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  let data: Record<string, unknown>;
  try {
    data = executeSelections(rootType, null, operation.selections, ctx, errors);
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
  if (errors.length > 0) return { data: null, errors };
  return { data };
}

function executeOne(store: Store, entry: unknown): GraphQLResult {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let operations: OperationNode[];
  try {
    operations = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let operation = operations[0];
  if (operationName !== null) {
    const found = operations.find((candidate) => candidate.name === operationName);
    if (found === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
    operation = found;
  }
  const variables =
    typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
  return executeOperation(store, operation, variables);
}

// ---------------------------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------------------------

export interface GraphQLHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** POST /api/graphql: one operation object, or a JSON array of them (batching). */
export function handleGraphQL(
  store: Store,
  body: unknown,
  bodyParseError: boolean,
  token: string | null,
  validToken: string,
): GraphQLHttpResponse {
  if (token === null || token !== validToken) {
    return { status: 401, body: { data: null, errors: [{ message: 'Bad credentials' }] } };
  }
  if (bodyParseError) {
    return { status: 400, body: { data: null, errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, entry)) };
  }
  return { status: 200, body: executeOne(store, body) };
}
