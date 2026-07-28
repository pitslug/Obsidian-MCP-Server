# Deploying to the Slugworx stack

Follows the conventions in the homelab deployment standard: secrets as Docker
secrets consumed through `*_FILE`, config under `$DATADIR/<service>`, host port
via a `$*_PORT` variable, hostname via `$DOMAINNAME`.

## What it does on start

1. Reads the vault's storage settings from `_local/obsydian_livesync_milestone`
   — not from configuration, which is only an override.
2. Replicates the whole database into `/data/replica`, pull-only.
3. Waits for that first pass to finish, then serves MCP.

First start replicates everything, which for a vault of this size is a minute
or two. `start_period: 60s` on the healthcheck covers it; raise it if the
container is marked unhealthy before it finishes.

## Steps

1. Put a checkout of the repository somewhere on the server, and point
   `$OBSIDIAN_MCP_SRC` at it.

2. Create the secrets:

   ```bash
   printf '%s' 'the-couchdb-password'  > $SECRETSDIR/obsidian_mcp_couchdb_password
   openssl rand -base64 48 | tr -d '\n' > $SECRETSDIR/obsidian_mcp_bearer_token
   chmod 600 $SECRETSDIR/obsidian_mcp_*
   ```

   `printf` rather than `echo`, so no trailing newline lands in the password.
   (The server strips one anyway, but the habit is worth keeping for secrets
   read by things that do not.)

3. Copy `obsidian-mcp.env.example` to `$ENVDIR/obsidian-mcp.env` and set the
   CouchDB URL, database and username.

4. Add to `.env`:

   ```
   OBSIDIAN_MCP_PORT=8095
   OBSIDIAN_MCP_SRC=/mnt/user/appdata/src/obsidian-mcp-server
   ```

5. Copy `compose/obsidian-mcp.yml` into `compose/`, add the `include:` line to
   `slugworx-docker.yml`, then:

   ```bash
   docker compose -f slugworx-docker.yml up -d --build obsidian-mcp
   ```

6. Watch the first replication:

   ```bash
   docker logs -f obsidian-mcp
   ```

7. Confirm it is up, and that the token is actually required:

   ```bash
   curl -s https://obsidian-mcp.slugworx.net/health          # → ok
   curl -s -o /dev/null -w '%{http_code}\n' \
        https://obsidian-mcp.slugworx.net/mcp                # → 401
   ```

## Authentication

The service authenticates its own callers with a bearer token, so it sits
behind `chain-no-auth@file` rather than `chain-auth@file`. Pocket-ID in front
would block MCP clients, which cannot complete an interactive OIDC flow.

That is weaker than the design intends. The design calls for OAuth 2.0 with
PKCE implemented in the server, which is what Claude's custom connector flow
expects, with an IP allowlist or Cloudflare Access in front during initial
rollout. Until that exists, consider adding one of those as a second layer —
the token is a single shared credential, and it is the only thing between the
internet and the full text of the vault.

## Rollback

Stopping the container removes nothing: it is not a sync peer, and it has never
written to CouchDB. Devices carry on exactly as before.

```bash
docker compose -f slugworx-docker.yml stop obsidian-mcp
rm -rf $DATADIR/obsidian-mcp/replica    # optional; rebuilds on next start
```

No Obsidian plugin configuration is touched, so there is no client-side change
to undo.

## Backups

`$DATADIR/obsidian-mcp` holds only the replica, which is derived from CouchDB
and rebuilds itself. It does not need to be in the nightly backup, and
excluding it saves backing up a second copy of the vault. The vault's own
backup is CouchDB's.
