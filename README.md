# DigitalOcean Managed Database — Live Migration Tool

A web app with two steps:

1. **AI migration plan** — describe your source database, pick a DigitalOcean Managed
   Database target engine, and get a plan, commands, cutover/validation steps, and rollback
   notes from DigitalOcean Serverless Inference (`/v1/chat/completions`).
2. **Live migration** — actually connect to a real source database and a real destination
   (a DigitalOcean Managed Database), pick which tables/collections to copy, and run the
   migration with a live progress log in the browser.

## Supported live engines

PostgreSQL, MySQL, and MongoDB — **source and destination must use the same engine** (e.g.
Postgres → DO Managed PostgreSQL). Cross-engine conversions (e.g. MySQL → DO PostgreSQL) are
covered by the AI plan step only; apply that plan manually with your own tooling.

DigitalOcean Managed Databases also support Kafka, Valkey (Redis-compatible), and OpenSearch —
those show up as AI-plan targets but aren't wired up for live execution in this tool.

## What the live migration actually does

- **PostgreSQL / MySQL**: reads the source table list and column definitions from
  `information_schema`, creates matching tables in the destination (`CREATE TABLE IF NOT
  EXISTS`), and copies rows in batches of 500 via `SELECT ... LIMIT/OFFSET` + batched `INSERT`.
- **MongoDB**: lists source collections, and copies documents in batches of 500 via
  `find()` + `insertMany()`.
- Progress streams to the browser as newline-delimited JSON (NDJSON) over a chunked HTTP
  response — no external job queue needed for a single migration run.

This is a straightforward lift-and-shift for small/medium tables — it does **not** handle
indexes, constraints, foreign keys, sequences/auto-increment continuation, incremental sync,
or very large tables efficiently. Treat it as a demo/utility, not a production migration
pipeline (for that, DigitalOcean's docs point to engine-native tools like `pg_dump`/`pg_restore`
or a proper CDC tool).

## Security notes

- Credentials are sent once from the browser to this app's own backend (POST body only —
  never in a URL/query string) and held in memory only for the duration of that one request.
  Nothing is written to disk or logged.
- Run this locally or behind HTTPS (App Platform provides HTTPS automatically) since
  credentials do travel over the network to reach this server.
- Always test against a non-production destination first, and keep the source live/untouched
  until you've validated the destination.
- DigitalOcean Managed Database clusters require TLS for every connection and only accept
  connections from hosts allowed under **Trusted Sources** in the cluster's firewall settings —
  make sure wherever you run this tool is allowed in first.

## What's inside

- `adapters/postgres.js`, `adapters/mysql.js`, `adapters/mongo.js` — a uniform
  `connect / disconnect / listTables / migrateOne` interface per engine
- `server.js` — Express server: `/api/plan` (AI plan via Serverless Inference),
  `/api/test-connection` (real connection test + table/collection listing),
  `/api/migrate-run` (real migration, streamed as NDJSON)
- `public/` — static frontend: AI plan form, source/destination connection forms, table
  picker with per-table progress bars, and a live log panel

## Run locally

```bash
cd do-managed-db-live-migration-tool
npm install
cp .env.example .env
# edit .env and set MODEL_ACCESS_KEY to your DO Serverless Inference key
npm start
```

Open http://localhost:8080.

## Environment variables

| Variable | Description |
|---|---|
| `MODEL_ACCESS_KEY` | Your DO Serverless Inference Model Access Key (for Step 1 only) |
| `TEXT_MODEL` | Chat model slug, e.g. `llama3.3-70b-instruct` |
| `PORT` | Port to listen on (default `8080`) |

## Deploy to App Platform

1. Push this folder to a GitHub repo.
2. Update the `github.repo` field in `.do/app.yaml` to point at that repo.
3. Create the app, then set the real `MODEL_ACCESS_KEY` secret (don't commit it):
   ```bash
   doctl apps create --spec .do/app.yaml
   doctl apps update <app-id> --spec .do/app.yaml
   ```
4. Make sure the App Platform egress can reach both your source database and your
   destination Managed Database cluster (add it to Trusted Sources on the DO side).
