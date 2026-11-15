// The forge's in-memory state: repositories (objects, refs, issues, pull requests, labels,
// comments) plus the domain operations the REST, GraphQL and MCP surfaces share — creating a
// commit for a contents write, opening and squash-merging a pull request, and the global-id
// scheme GraphQL uses. Everything is per-process; a trial is one process.

import {
  buildCommit,
  buildTreeFromFiles,
  diffFlat,
  flattenTree,
  hashObject,
  isAncestor,
  listCommits,
  mergeBase,
  parseCommit,
  type FlatFile,
  type GitObject,
  type GitObjectType,
  type TreeDiffEntry,
} from './gitcore.ts';
import { VIEWER } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';
/** Fixed timestamp for every server-created commit (deterministic bytes, never Date.now()). */
export const SERVER_COMMIT_TIMESTAMP = 1700000000;

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Object id -> object. */
  readonly objects: Map<string, GitObject>;
  /** Ref name -> tip oid. */
  readonly refs: Map<string, string>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  readonly labels: Map<string, Label>;
  /** Issue/PR number -> comments. */
  readonly comments: Map<number, Comment[]>;
  /** One counter for issues and pull requests, as on GitHub. */
  nextNumber: number;
  /** Bumped on every mutation (pack-cache invalidation). */
  version: number;
}

let nextRepoId = 1;
let nextObjectId = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export function viewerLogin(): string {
  return VIEWER.login;
}

export function viewerIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

export class Store {
  readonly repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = nowIso();
    const repo: Repo = {
      id: nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      version: 0,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -- objects ---------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store a whole pack's objects; returns the stored count. */
  storeObjects(repo: Repo, objects: ReadonlyMap<string, GitObject>): number {
    let stored = 0;
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        stored += 1;
      }
    }
    return stored;
  }

  // -- refs ------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
    repo.updatedAt = nowIso();
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const removed = repo.refs.delete(ref);
    if (removed) {
      repo.version += 1;
      repo.updatedAt = nowIso();
    }
    return removed;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveRef(repo: Repo, ref: string | undefined): string | undefined {
    if (ref === undefined || ref === '') return this.branchTip(repo, repo.defaultBranch);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = this.branchTip(repo, ref);
    if (branch !== undefined) return branch;
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  // -- commits ---------------------------------------------------------------

  /** Create a commit object on top of `parents` with `tree`; does not move any ref. */
  createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const body = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({
      tree,
      parents,
      message: body,
      author: viewerIdentity(),
      committer: viewerIdentity(),
      timestamp: SERVER_COMMIT_TIMESTAMP,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The flat file map of a branch tip (empty when the branch has no commits). */
  branchFiles(repo: Repo, branch: string): Map<string, FlatFile> {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return new Map();
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return new Map();
    return flattenTree(parseCommit(commit.data).tree, this.lookup(repo));
  }

  /**
   * Write (create or update) one file on `branch`, creating the branch from the default tip
   * when it does not exist yet. Returns the new blob oid and commit oid.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { blobOid: string; commitOid: string; created: boolean } {
    let tip = this.branchTip(repo, branch);
    let createdBranch = false;
    if (tip === undefined) {
      tip = this.branchTip(repo, repo.defaultBranch);
      createdBranch = true;
    }
    const blobOid = this.putObject(repo, 'blob', content);
    // A new branch starts from the default branch's tree, not from an empty tree.
    const sourceBranch = createdBranch ? repo.defaultBranch : branch;
    const files = tip === undefined ? new Map<string, FlatFile>() : this.branchFiles(repo, sourceBranch);
    const created = !files.has(path);
    files.set(path, { oid: blobOid, mode: '100644' });
    const tree = buildTreeFromFiles(files, (type, data) => this.putObject(repo, type, data));
    const commitOid = this.createCommit(repo, tree, tip === undefined ? [] : [tip], message);
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    return { blobOid, commitOid, created };
  }

  /** Delete one file on `branch`. Returns the new commit oid, or null when the file is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const files = this.branchFiles(repo, branch);
    if (!files.has(path)) return null;
    files.delete(path);
    const tree = buildTreeFromFiles(files, (type, data) => this.putObject(repo, type, data));
    const commitOid = this.createCommit(repo, tree, [tip], message);
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  listCommitShas(repo: Repo, ref: string | undefined, limit = 1000): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return [];
    return listCommits(tip, this.lookup(repo), limit);
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = nowIso();
    const issue: Issue = {
      id: nextObjectId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    repo.version += 1;
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const comment: Comment = { id: nextObjectId++, body, createdAt: nowIso() };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    repo.version += 1;
    return comment;
  }

  // -- pull requests -----------------------------------------------------------

  createPullRequest(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const now = nowIso();
    const pull: PullRequest = {
      id: nextObjectId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    repo.version += 1;
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  openPullForHead(repo: Repo, headRef: string, baseRef: string): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
  }

  /** The merge-base of a pull request's current head and base tips. */
  pullMergeBase(repo: Repo, pull: PullRequest): string | null {
    const head = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const base = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    return mergeBase(head, base, this.lookup(repo));
  }

  /** The files a pull request changes, against its merge-base. */
  pullFiles(repo: Repo, pull: PullRequest): TreeDiffEntry[] {
    const head = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const base = mergeBase(head, this.branchTip(repo, pull.baseRef) ?? pull.baseSha, this.lookup(repo));
    const headCommit = repo.objects.get(head);
    if (!headCommit || headCommit.type !== 'commit') return [];
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, this.lookup(repo));
    if (base === null) {
      return diffFlat(new Map(), headFiles);
    }
    const baseCommit = repo.objects.get(base);
    if (!baseCommit || baseCommit.type !== 'commit') return diffFlat(new Map(), headFiles);
    return diffFlat(flattenTree(parseCommit(baseCommit.data).tree, this.lookup(repo)), headFiles);
  }

  /** Whether a pull request can merge cleanly (no path changed on both sides differently). */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const head = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(head, baseTip, this.lookup(repo));
    if (base === null) return false;
    const lookup = this.lookup(repo);
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(head);
    const tipCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return false;
    const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const tipFiles = flattenTree(parseCommit(tipCommit.data).tree, lookup);
    const headDiff = diffFlat(baseFiles, headFiles);
    const tipDiff = new Map(diffFlat(baseFiles, tipFiles).map((entry) => [entry.path, entry]));
    for (const entry of headDiff) {
      const other = tipDiff.get(entry.path);
      if (!other) continue;
      // Both sides changed the same path: a conflict unless they produced the same result.
      if (other.newOid !== entry.newOid) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request: one commit on the base branch carrying the head's changes.
   * Returns the merge commit oid, or null when the pull request cannot merge.
   */
  mergePullRequest(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const head = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const lookup = this.lookup(repo);
    const headCommit = repo.objects.get(head);
    const tipCommit = repo.objects.get(baseTip);
    if (!headCommit || !tipCommit) return null;
    const base = mergeBase(head, baseTip, lookup);
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const tipFiles = flattenTree(parseCommit(tipCommit.data).tree, lookup);
    const mergedFiles = new Map(tipFiles);
    if (base === null) {
      for (const [path, file] of headFiles) mergedFiles.set(path, file);
    } else {
      const baseCommit = repo.objects.get(base);
      const baseFiles = baseCommit ? flattenTree(parseCommit(baseCommit.data).tree, lookup) : new Map();
      for (const entry of diffFlat(baseFiles, headFiles)) {
        if (entry.status === 'removed') mergedFiles.delete(entry.path);
        else if (entry.newOid !== null) {
          mergedFiles.set(entry.path, { oid: entry.newOid, mode: headFiles.get(entry.path)?.mode ?? '100644' });
        }
      }
    }
    const tree = buildTreeFromFiles(mergedFiles, (type, data) => this.putObject(repo, type, data));
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitOid = this.createCommit(repo, tree, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = nowIso();
    return commitOid;
  }

  /** Whether `newOid` is a fast-forward of the current tip of `ref` (or a create). */
  isFastForward(repo: Repo, ref: string, oldOid: string, newOid: string): boolean {
    const current = repo.refs.get(ref);
    if (current === undefined) return oldOid === '0'.repeat(40);
    if (oldOid !== current) return false;
    if (newOid === current) return true;
    return isAncestor(current, newOid, this.lookup(repo));
  }
}

// ---------------------------------------------------------------------------------------------
// Global ids (GraphQL Relay ids): opaque, stable, typed. base64url of "<Type>:<key>".
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, number: number): string {
  return encodeGlobalId('Issue', `${repo.owner}/${repo.name}#${number}`);
}

export function pullGlobalId(repo: Repo, number: number): string {
  return encodeGlobalId('PullRequest', `${repo.owner}/${repo.name}#${number}`);
}

export function commentGlobalId(repo: Repo, number: number, commentId: number): string {
  return encodeGlobalId('IssueComment', `${repo.owner}/${repo.name}#${number}:${commentId}`);
}
