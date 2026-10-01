# ClickHouse

Column-oriented SQL database for real-time analytics.

> **Draft.** The template deploys and has been verified end to end; it stays out of the catalog
> while the publish decision is pending. What a reviewer is deciding is whether a database whose
> entire SQL surface sits on a public URL behind a single password belongs in a one-click gallery,
> and the HTTP interface is the only one a routed port can carry, so there is no narrower face to
> ship instead.

## Overview

[ClickHouse](https://github.com/ClickHouse/ClickHouse) is an open-source column-oriented database
built for analytical queries: aggregations over billions of rows, with the data laid out by column
and compressed so that a query reads only the columns it names. It speaks SQL, and it is the
database behind a lot of observability, product-analytics and log-search stacks.

This template runs the official `docker.io/library/clickhouse` image. The overlay image it builds
adds exactly two files and changes nothing about the server:

- a `config.d` drop-in that moves every path the server writes to onto the volume at `/data`, and
  turns on console logging so the platform's log view shows something. The stock `config.xml`
  spells those paths absolutely under `/var/lib/clickhouse` and no environment variable moves any
  of them, which is the whole reason this template is not a bare `image:` reference.
- a wrapper that maps `ADMIN_USERNAME` / `ADMIN_PASSWORD` onto the `CLICKHOUSE_USER` /
  `CLICKHOUSE_PASSWORD` that upstream's own entrypoint reads, then execs it.

The service URL is ClickHouse's **HTTP interface** on port 8123. That is the interface, not a web
app someone wrote on top: the same URL serves the built-in Play query console at `/play`, the
built-in dashboard at `/dashboard`, and `POST` of raw SQL for every HTTP client.

## What you get by hosting it

- An HTTPS URL for the ClickHouse HTTP interface, with no port forwarding or tunnel to manage.
- The built-in **Play** console at `/play`: a query box, results as a table, and the query history,
  served by the server itself with nothing to install.
- A SQL account you name at deploy time, created with access management on, so `CREATE USER`,
  `GRANT` and the rest of the access DDL work from Play. The stock `default` user is removed.
- A persistent volume at `/data`, with the data directory, the temporary directory, `user_files`,
  the format schemas and the SQL-created users and grants all pointed into it, so a restart or a
  redeploy keeps both the tables and the accounts that can read them.
- Deploys are health-gated on `/ping`, which answers only once the server has loaded its databases.
- The machine idle-stops and wakes on the next query, so an analytics database you touch a few
  times a day is not billed around the clock.

## What you need before deploying

- A username and a password of your choosing. There is no default and nothing is generated: the
  deploy form starts with both fields empty and will not submit until you fill them. A password the
  platform minted would be one it could never show you again, because a template variable is stored
  write-only.
- The username is written into an XML config file as an element name, so keep it to letters, digits
  and underscores, and do not start it with a digit.

That is all. Databases, tables and further users are created in SQL after deploy.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Name of the ClickHouse account the template creates. You choose it. Letters, digits and underscores; not starting with a digit, because upstream's entrypoint writes it into XML as an element name. |
| `ADMIN_PASSWORD` | yes | Password for that account. You choose it. It is the only gate in front of the URL. |

Set by the template, not by you: `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`, so the account can run
`CREATE USER` and `GRANT`. The data paths are set in the image's `config.d` drop-in rather than as
variables, because ClickHouse has no environment variable for any of them.

## After deploy

1. Wait for the health check on `/ping` to pass, then open `<your-url>/play`.
2. Fill in the **User** and **Password** boxes at the top right of Play with the `ADMIN_USERNAME`
   and `ADMIN_PASSWORD` you deployed with. Play keeps them in the browser for the next query.
3. Create something and read it back:

   ```sql
   CREATE DATABASE demo;
   CREATE TABLE demo.events (ts DateTime, name String) ENGINE = MergeTree ORDER BY ts;
   INSERT INTO demo.events VALUES (now(), 'hello');
   SELECT * FROM demo.events;
   ```

4. From anything else, use an HTTP client. The native protocol on port 9000 is not routed, so
   `clickhouse-client` cannot reach this service; `clickhouse-connect`, the JDBC/ODBC drivers in
   HTTP mode, and plain `curl` can:

   ```bash
   curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" "https://<your-url>/" \
     --data-binary "SELECT count() FROM demo.events"
   ```

5. `/dashboard` serves ClickHouse's built-in metrics dashboard against the same credentials.
6. Everything lives under `/data/clickhouse`. Deleting the volume resets the server to a fresh
   install, including the accounts created in SQL.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream's `26.8.11.7` index carries both, and
  this image only copies in a config file and a wrapper script.
- Documentation: <https://clickhouse.com/docs>
- HTTP interface reference: <https://clickhouse.com/docs/interfaces/http>
- Upstream: <https://github.com/ClickHouse/ClickHouse>
- Image: `docker.io/library/clickhouse`, pinned to `26.8.11.7` (the LTS line)
- License: Apache-2.0 (upstream `ClickHouse/ClickHouse`).
