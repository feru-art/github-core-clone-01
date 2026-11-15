# github-core-clone-01

A minimal GitHub-compatible forge: REST v3, GraphQL v4, MCP (2026-07-28), and smart-HTTP
git (protocol v0 and v2), all in memory, Node 22 stdlib only, no dependencies.

## Run

```sh
MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types main.ts
```

`main.ts` is the make.fun lifecycle: it binds an ephemeral port, registers it with the
env at `$MAKEFUN_ENV_URL`, and polls `/done` until the trial ends. For a local run,
`serve-local.ts` (outside this repo, in the competition folder) listens on a fixed port
instead; point the kit's runner at it:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8080 --token dev-token [--perf]
```

## Layout

- `app.ts` — the HTTP router (healthz, REST, GraphQL, MCP, git).
- `rest.ts` — REST v3: repos, issues, pull requests, labels, comments, contents, git refs.
- `graphql.ts` — a small GraphQL parser and executor for the suite's documents.
- `mcp.ts` — the MCP endpoint: `server/discover`, `tools/list`, `tools/call`, six tools.
- `gitproto.ts` — smart HTTP: info/refs (v0/v2), ls-refs, fetch (v0/v2), receive-pack.
- `gitcore.ts` — git objects, packs (read with deltas, write delta-free), pkt-line, closure.
- `store.ts` — the in-memory store: repos, refs, objects, issues, pull requests, merges.
- `scenario.ts` — the seeded viewer identity (adaiversen, id 1000).

## Notes

- Every reply is JSON (never HTML) with `X-GitHub-Request-Id` on the REST surface.
- Server-created commits use the fixed timestamp 1700000000 and the viewer's identity.
- Global GraphQL ids are opaque base64url `Type:key` values, stable across reads.
- Packs are written delta-free; incoming packs may carry deltas and are resolved on read.
