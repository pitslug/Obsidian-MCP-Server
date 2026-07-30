# Deploying to the Slugworx stack

Follows the conventions in the homelab deployment standard: secrets as Docker
secrets consumed through `*_FILE`, config under `$DATADIR/<service>`, host port
via a `$*_PORT` variable, hostname via `$DOMAINNAME`.

## What it does on start

1. Reads the vault's storage settings from `_local/obsydian_livesync_milestone` - not from configuration, which is only an override.
2. Replicates the whole database into `/data/replica`, pull-only.
3. Waits for that first pass to finish, then serves MCP.

First start replicates everything, which for a vault of this size is a minute
or two. `start_period: 60s` on the healthcheck covers it; raise it if the
container is marked unhealthy before it finishes.

## Before anything else

**Pocket-ID must be v2.10.0 or later.** That release added OAuth APIs with
scoped permissions, and this service is built on them: it is an OAuth 2.1
resource server that accepts only tokens audience-bound to itself. Pocket-ID is
one of the pinned images on this stack, so check what is actually running before
starting.

Register two things in Pocket-ID, in this order:

1. **An API**, identifier `https://obsidian-mcp.slugworx.net/mcp`, with the
   permissions `vault:read` and `vault:write`. The identifier must match
   `MCP_PUBLIC_URL` and the URL typed into Claude, character for character.

    Not optional. Claude always sends that URL as the RFC 8707 `resource`
    parameter, and Pocket-ID answers a `resource` naming an API it does not know
    with `invalid_target`, which fails the authorization request before any token
    exists. The symptom is a connector that will not connect, with nothing wrong
    at this end and no request ever reaching this service.

2. **An OIDC client** called something like `Claude`, confidential, PKCE on,
   with both callback URLs, since Claude uses either host:

       https://claude.ai/api/mcp/auth_callback
       https://claude.com/api/mcp/auth_callback

    Grant it `vault:read` on the API above. Grant `vault:write` later, when
    writes are meant to be on.

Keep the client ID and secret: they go into Claude, not into this deployment.
Nothing here holds an OAuth credential.

## Steps

1. Make sure the image exists and the server can pull it.

    `.github/workflows/docker-publish.yml` builds and pushes to GHCR on every
    push to `main`, same as `onenote-mcp`. Nothing is checked out on the server.

    **GHCR packages start private even when the repository is public.** Left
    private, the first `docker compose pull` fails with a 401 that reads like a
    missing image rather than a permission problem.

    The package does not exist until the first workflow run succeeds, so this
    comes after the first push, not before:

        https://github.com/users/pitslug/packages/container/obsidian-mcp-server/settings

    Danger Zone, Change visibility, Public, then type the package name to
    confirm. One way: a public package cannot be made private again.

    The alternative is to leave it private and run
    `docker login ghcr.io -u pitslug` on the server with a token carrying
    `read:packages`. That works and changes nothing in the compose file; it is
    one more credential to keep track of.

    The compose file pulls `:edge`, which is whatever is on `main`. Once the
    work is settled, tag a release and pin to it:

    ```bash
    git tag v0.1.0 && git push --tags
    ```

    That produces `:0.1.0`, `:0.1`, `:0` and `:latest`. Pin to `:0.1` in the
    compose file: this service holds transcriptions nothing can recompute, and
    the stack pins stateful services for exactly that reason.

2. Create the data directory and the secret:

    ```bash
    mkdir -p $DATADIR/obsidian-mcp
    chown -R $PUID:$PGID $DATADIR/obsidian-mcp

    printf '%s' 'the-couchdb-password' > $SECRETSDIR/obsidian_mcp_couchdb_password
    chmod 600 $SECRETSDIR/obsidian_mcp_couchdb_password
    ```

    The `mkdir` and `chown` are not optional, and this service is the unusual
    one on the stack in needing them. It runs as `user: "$PUID:$PGID"` because
    the image has no PUID entrypoint of its own, so unlike a linuxserver.io
    container it cannot correct the ownership after the fact. Left to create the
    directory itself, Docker makes it `root`, the LevelDB replica fails to open,
    and the failure lands inside a promise rather than at startup: the container
    reports healthy-ish, logs "Replicating. Waiting for the first pass to
    complete", and then simply waits. An empty `$DATADIR/obsidian-mcp` is the
    tell.

    `printf` rather than `echo`, so no trailing newline lands in the password.
    (The server strips one anyway, but the habit is worth keeping for secrets
    read by things that do not.)

    There is no bearer token secret under `AUTH_MODE=oauth`. The compose file
    keeps one commented out for the fallback mode.

3. Copy `obsidian-mcp.env.example` to `$ENVDIR/obsidian-mcp.env`. The values
   that matter:

    - `COUCHDB_URL` - the **internal** address, `http://couchdb:5984`. Not the
      public hostname: Traefik answers 400 to a percent-encoded slash, and every
      document ID here is a vault path, so single-document reads fail against it
      while replication succeeds.
    - `MCP_PUBLIC_URL=https://obsidian-mcp.slugworx.net/mcp` - exactly as above.
    - `OAUTH_ISSUER=https://auth.slugworx.net`
    - `VAULT_TIMEZONE=Australia/Brisbane` - the container runs in UTC, so
      without this every evening's `append_daily` capture is filed under the
      previous day and nothing reports an error.
    - `READ_ONLY=true` for the first period.

4. Add to `.env`:

    ```
    OBSIDIAN_MCP_PORT=8095
    ```

    `$OBSIDIAN_MCP_SRC` is only needed if you uncomment the `build:` block to
    build locally instead of pulling.

5. Copy `compose/obsidian-mcp.yml` into `compose/`, add the `include:` line to
   `slugworx-docker.yml`, then:

    ```bash
    docker compose -f slugworx-docker.yml pull obsidian-mcp
    docker compose -f slugworx-docker.yml up -d obsidian-mcp
    ```

6. Watch the first replication:

    ```bash
    docker logs -f obsidian-mcp
    ```

    It logs the auth mode on startup. The line to look for begins
    `Callers authenticate with OAuth 2.1 against` and names Pocket-ID. Anything
    else means the env file did not take.

7. Check the handshake from outside, which is the part that is easy to get
   wrong and silent when it is:

    ```bash
    # Unauthenticated: 200, and says nothing about the vault
    curl -s https://obsidian-mcp.slugworx.net/health

    # The metadata a client discovers. resource must be the exact URL above,
    # and authorization_servers must name Pocket-ID.
    curl -s https://obsidian-mcp.slugworx.net/.well-known/oauth-protected-resource

    # The challenge. 401, and the header must carry resource_metadata.
    curl -si -X POST https://obsidian-mcp.slugworx.net/mcp \
         -H 'content-type: application/json' \
         -H 'accept: application/json, text/event-stream' \
         -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
    ```

    A `WWW-Authenticate` without `resource_metadata=` is the failure worth
    catching here: the client never learns where the authorization server is,
    and reports only that it could not reach the server.

8. Add the connector in Claude: a custom connector pointed at
   `https://obsidian-mcp.slugworx.net/mcp`, with the client ID and secret from
   Pocket-ID.

9. Then the usual checklist items: a Homepage entry, and an Uptime Kuma monitor
   against `http://obsidian-mcp:8080/health` on `docker_net`. Monitor `/health`
   rather than `/mcp`, which correctly answers 401 and would read as down.

## Rolling out writes

Four separate switches stand between this container and the vault, and they are
worth moving one at a time rather than together:

1. `READ_ONLY=true`, and the client granted only `vault:read`. Live with it.
2. `READ_ONLY=false`, client still only `vault:read`. Every write tool should
   refuse, naming `vault:write`. This proves the scope gate rather than assuming
   it, and it costs one reconnect.
3. Grant `vault:write` in Pocket-ID, against `obsidian-writetest`.
4. Point `COUCHDB_DATABASE` at `obsidiandb`.

Step 2 is the one that is easy to skip. It is also the only step that tests a
control rather than exercising a path that was already open.

## Network

Anthropic's traffic comes from `160.79.104.0/21` and must reach **both**
`obsidian-mcp.slugworx.net` and `auth.slugworx.net`. Discovery requests to
Pocket-ID come from the same range as the MCP requests, so a Cloudflare rule or
WAF that covers one host and not the other breaks the flow in a way that looks
like this service being unreachable.

Claude waits 10 seconds for discovery and token endpoints and 30 for refresh.
Traefik's rate limit (`average: 100`) is far above anything a connector
generates.

## Rollback

Stopping the container removes nothing, and while `READ_ONLY=true` it has never
written to CouchDB. Devices carry on exactly as before.

To go back a version rather than stop, every build is tagged with its commit,
so there is always something exact to pin to:

```bash
docker compose -f slugworx-docker.yml pull obsidian-mcp   # after editing the tag
```

```bash
docker compose -f slugworx-docker.yml stop obsidian-mcp
rm -rf $DATADIR/obsidian-mcp/replica       # optional; rebuilds on next start
rm -f  $DATADIR/obsidian-mcp/index.sqlite  # optional; rebuilds from the replica
```

**Do not delete `$DATADIR/obsidian-mcp/transcripts.sqlite`.** See below.

No Obsidian plugin configuration is touched, so there is no client-side change
to undo.

## Backups

`$DATADIR/obsidian-mcp` must be in the nightly backup, for one file in it.

The replica and the index are derived: destroy either and it rebuilds from
CouchDB, and the vault's real backup is CouchDB's own. But `transcripts.sqlite`
holds the transcriptions of handwritten pages, and **nothing can recompute
them** - each one exists because a model read the ink once. It is the only data
in this system that is not a copy of something else.

That is why the store is a separate file from the index, runs in
`journal_mode = DELETE` so a file-level backup cannot copy it mid-write, and
keeps a history table so a bad rewrite does not destroy a good transcription.
None of that helps if the directory is excluded from the backup.

An earlier version of this file said the opposite, on the reasoning that the
directory held only the replica. That was true when it was written, and stopped
being true when transcription landed.
