// The smart-HTTP surface: info/refs advertisements (protocol v0 and v2), v2 ls-refs, v2 and
// v0 fetch, and v0 receive-pack (push). Speaks exactly what git-client.ts sends: pkt-line
// framing, sideband-64k pack delivery, shallow/deepen negotiation, per-ref report-status.
// No deltas are ever generated (the suite accepts a delta-free pack); incoming packs may
// carry deltas and are resolved on read.

import {
  ZERO_OID,
  decodePktLines,
  decodePktLinesHead,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseTag,
  planFetch,
  readPack,
  writePack,
  type GitObject,
  type PktItem,
} from './gitcore.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';

/** Capabilities of the v0 upload-pack advertisement. */
const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not ' +
  'deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want ' +
  'allow-reachable-sha1-in-want symref=HEAD:refs/heads/main agent=' + AGENT;

/** Capabilities of the v0 receive-pack advertisement (report-status, side-band-64k, delete-refs are required). */
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** The v2 capability lines (ls-refs and fetch are required; object-format must be sha1). */
const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`];

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function json404(message: string): GitResponse {
  return {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function textError(status: number, message: string): GitResponse {
  return { status, contentType: 'text/plain', body: Buffer.from(message, 'utf8') };
}

/** All refs of a repo, sorted: heads first, then tags, then the rest. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => {
    const rank = (name: string): number =>
      name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2;
    const ra = rank(a.name);
    const rb = rank(b.name);
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return refs;
}

function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The v0 ref advertisement: preamble, HEAD + caps, refs, peeled tags, flush. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const items: PktItem[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    const tip = defaultTip(repo) ?? refs[0].oid;
    items.push(`${tip} HEAD\u0000${caps}\n`);
    for (const ref of refs) {
      items.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object && object.type === 'tag') {
          const peeled = parseTag(object.data).object;
          items.push(`${peeled} ${ref.name}^{}\n`);
        }
      }
    }
  }
  items.push('flush');
  return encodePktLines(items);
}

/** The v2 capability advertisement: preamble, `version 2`, capability lines, flush. */
function advertisementV2(service: 'git-upload-pack'): Buffer {
  const items: PktItem[] = [`# service=${service}\n`, 'flush', 'version 2\n'];
  for (const cap of V2_CAPS) items.push(`${cap}\n`);
  items.push('flush');
  return encodePktLines(items);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocolHeader: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Repository not found');
  if (service === 'git-upload-pack') {
    const wantsV2 = gitProtocolHeader !== undefined && gitProtocolHeader.includes('version=2');
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: wantsV2 ? advertisementV2('git-upload-pack') : advertisementV0(repo, 'git-upload-pack'),
    };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: advertisementV0(repo, 'git-receive-pack'),
    };
  }
  return json404('Unknown service');
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (afterDelim) lines.push(packet.payload.toString('utf8'));
  }
  const args = parseLsRefsArgs(lines);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const out: PktItem[] = [];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    if (args.symrefs && tip !== undefined && keep('HEAD')) {
      out.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object && object.type === 'tag') {
          const peeled = parseTag(object.data).object;
          line += ` peeled:${peeled}`;
        }
      }
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: encodePktLines(out),
  };
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

/** Pack cache: one entry per (repo version, wants, haves, shallow, depth). Cleared on overflow. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 256;

function cachedPack(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | undefined,
): { pack: Buffer | null; shallowOut: string[]; unshallowOut: string[] } {
  const key = [
    repo.id,
    repo.version,
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    [...shallow].sort().join(','),
    depth === undefined ? '' : String(depth),
  ].join('|');
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const plan = planFetch(wants, haves, shallow, depth, lookup);
  if (plan.send.size === 0) return { pack: null, shallowOut: plan.shallow, unshallowOut: plan.unshallow };
  const cached = packCache.get(key);
  if (cached !== undefined) return { pack: cached, shallowOut: plan.shallow, unshallowOut: plan.unshallow };
  const objects: GitObject[] = [];
  for (const oid of [...plan.send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);
  if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
  packCache.set(key, pack);
  return { pack, shallowOut: plan.shallow, unshallowOut: plan.unshallow };
}

/** Split pack bytes into sideband band-1 packets (32768 data bytes each, far under the limit). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgsV2(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function handleFetchV2(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (afterDelim) lines.push(packet.payload.toString('utf8'));
  }
  const args = parseFetchArgsV2(lines);
  const { pack, shallowOut, unshallowOut } = cachedPack(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  if (args.haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    }
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(Buffer.from('0001', 'ascii')); // delim
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii')); // delim
  }
  if (pack !== null) {
    parts.push(encodePktLine('packfile\n'));
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
  }
  parts.push(Buffer.from('0000', 'ascii')); // flush
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

function parseFetchArgsV0(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function handleFetchV0(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const args = parseFetchArgsV0(lines);
  const { pack, shallowOut, unshallowOut } = cachedPack(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const oid of shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (args.haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii')); // flush
  if (pack !== null) {
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

/** POST /{owner}/{repo}.git/git-upload-pack: v2 (command=) or v0 (want/have) by the first line. */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Repository not found');
  try {
    const { packets } = decodePktLinesHead(body);
    const first = packets.find((packet) => packet.kind === 'data');
    const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
    if (firstLine.startsWith('command=ls-refs')) return handleLsRefs(repo, body);
    if (firstLine.startsWith('command=fetch')) return handleFetchV2(repo, body);
    if (firstLine.startsWith('command=')) {
      return textError(400, `unknown command ${JSON.stringify(firstLine.trim())}`);
    }
    return handleFetchV0(repo, body);
  } catch (err) {
    return textError(400, `malformed upload-pack request: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Parse the command section of a receive-pack body: pkt-lines up to the first flush, then the
 * raw pack bytes that follow. Returns the commands, the negotiated capabilities, and the pack.
 */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } {
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let firstLine = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated receive-pack command section');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in receive-pack');
    const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    let text = line;
    if (firstLine) {
      firstLine = false;
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(text.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, capabilities, pack: body.subarray(offset) };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Repository not found');
  let commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    const parsed = parseReceivePack(body);
    commands = parsed.commands;
    capabilities = parsed.capabilities;
    if (parsed.pack.length > 0) {
      const objects = readPack(parsed.pack);
      store.storeObjects(repo, objects);
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : String(err);
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else if (command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.deleteRef(repo, command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (current !== undefined && command.ref.startsWith('refs/tags/') && command.newOid !== current) {
        // Tags never fast-forward.
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!store.isFastForward(repo, command.ref, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      store.setRef(repo, command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }

  // The report-status stream: `unpack ok`, one ok/ng line per ref, flush. Inside sideband
  // band 1 when the client negotiated side-band-64k, as the raw pkt-line stream otherwise.
  const reportLines: PktItem[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  reportLines.push('flush');
  const useSideband = capabilities.has('side-band-64k');
  let out: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    for (const item of reportLines) {
      const framed = item === 'flush' ? Buffer.from('0000', 'ascii') : encodePktLine(item as string);
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), framed])));
    }
    out = Buffer.concat(parts);
  } else {
    out = encodePktLines(reportLines);
  }
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: out,
  };
}
