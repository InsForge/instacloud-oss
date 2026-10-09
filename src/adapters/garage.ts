import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunMode } from '../config'
import { docker } from '../docker'
import { bucketName, GARAGE_CONTAINER } from '../manageddb'
import { signRequest, presignGet, presignPost, parseListObjects, parseDeleteResult, escapeXml, type S3Creds } from '../s3'
import type { StorageAdapter, ObjectListing } from '../types'

// One SHARED Garage server (io-garage) serves every project; each storage service on a branch gets
// its own bucket AND its own access key scoped to exactly that bucket: a leaked credential can touch
// nothing else (verified: foreign buckets 403). S3-compatible, objects on a local docker volume.
// The container is attached to each branch network on provision so apps reach it at
// http://io-garage:3900, mirroring how the cloud injects an S3 endpoint. Clone = bucket copy
// (rclone sync). Public access = Garage's web endpoint (:3902, vhost per bucket). Handles are the
// bucket names the engine passes in (`io-<ref>-<name>`; legacy rows still carry `io-<ref>`); the
// access key is named after its bucket so destroy(bucket) finds it.
// Run modes differ in exactly two places (decision 20): the toml's root_domain (`.s3.<domain>` on
// a server, `.s3.garage.localhost` / `.web.garage.localhost` locally) and the AWS_ENDPOINT_URL_S3 a
// service is handed (`https://s3.<domain>` on a server, the branch-network name locally).
const GARAGE = GARAGE_CONTAINER
const IMAGE = 'dxflrs/garage:v2.3.0'
const RCLONE = 'rclone/rclone'
const S3_PORT = 3900
const WEB_PORT = 3902
const ADMIN_KEY = 'io-insta-admin' // internal key for clone/teardown; granted rw per bucket
/** A node row of `garage status`: the ID column is a long hex string, which the header line and
 *  every banner are not. One of these is the only proof that the status was read at all. */
const NODE_ROW = /^[0-9a-f]{8,}\b/i

export interface GarageOptions {
  configPath: string    // cfg.garageConfigPath
  hostEndpoint: string  // cfg.s3HostEndpoint (the daemon's own S3 calls and every URL it signs)
  mode: RunMode         // WP5: server mode never starts the container (compose manages it)
  domain: string        // WP5: root_domain of the toml in server mode
}

export class LocalGarage implements StorageAdapter {
  private ensured = false
  private adminCreds: { id: string; secret: string } | null = null

  constructor(private readonly opts: GarageOptions) {}

  private garage(args: string[]): Promise<Buffer> {
    return docker(['exec', GARAGE, '/garage', ...args])
  }

  /** Write the single-node config once (rpc secret persisted inside it).
   *
   *  The two root_domains are the whole run-mode difference (decision 20). Local mode keeps
   *  today's `.s3.garage.localhost` / `.web.garage.localhost`, so public reads stay at
   *  `http://<bucket>.web.garage.localhost:3902` and the router serves no bucket vhost. Server mode
   *  writes install.sh's toml: BOTH endpoints answer on `.s3.<domain>`, because
   *  `<bucket>.s3.<domain>` is one hostname whose upstream the router picks per request (a signed
   *  or non-GET request goes to the S3 API, an anonymous GET/HEAD to the web endpoint). Normally
   *  install.sh has already written this file and mounted it into the compose container; writing it
   *  here keeps a hand-assembled server install self-consistent instead of silently serving
   *  localhost vhosts. */
  private ensureConfig(): string {
    const p = this.opts.configPath
    if (!existsSync(p)) {
      const server = this.opts.mode === 'server'
      mkdirSync(dirname(p), { recursive: true })
      // 0600: the file carries `rpc_secret`. Both garage images run as root, so the container
      // still reads it through the read-only bind (install.sh writes the same file the same way).
      writeFileSync(p, [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "sqlite"',
        'replication_factor = 1',
        'rpc_bind_addr = "[::]:3901"',
        `rpc_secret = "${randomBytes(32).toString('hex')}"`,
        '[s3_api]',
        's3_region = "garage"',
        `api_bind_addr = "[::]:${S3_PORT}"`,
        `root_domain = "${server ? `.s3.${this.opts.domain}` : '.s3.garage.localhost'}"`,
        '[s3_web]',
        `bind_addr = "[::]:${WEB_PORT}"`,
        `root_domain = "${server ? `.s3.${this.opts.domain}` : '.web.garage.localhost'}"`,
        'index = "index.html"',
        '',
      ].join('\n'), { mode: 0o600 })
    }
    return p
  }

  /** Start the shared Garage once (idempotent) and initialize the single-node layout. */
  private async ensure(): Promise<void> {
    if (this.ensured) return
    const cfg = this.ensureConfig()
    const out = await docker(['ps', '-aq', '--filter', `name=^${GARAGE}$`])
    if (out.toString().trim()) {
      await docker(['start', GARAGE]).catch(() => { /* already running */ })
    } else if (this.opts.mode === 'server') {
      // WP6 (packaging): on a VPS the compose stack owns io-garage (container_name in compose.yml,
      // bind dirs under <dataDir>/garage written by install.sh); the daemon only initialises the
      // layout. Starting it here would race compose and mount named volumes the installer never sees.
      throw new Error('io-garage is managed by compose in server mode: run docker compose up -d in /etc/instacloud')
    } else {
      const base = ['run', '-d', '--restart', 'unless-stopped', '--name', GARAGE,
        '-v', `${cfg}:/etc/garage.toml:ro`,
        '-v', 'io-garage-meta:/var/lib/garage/meta', '-v', 'io-garage-data:/var/lib/garage/data']
      // host ports are best-effort convenience (S3 + public web endpoint from the host)
      try { await docker([...base, '-p', `${S3_PORT}:${S3_PORT}`, '-p', `${WEB_PORT}:${WEB_PORT}`, IMAGE]) }
      catch {
        await docker([...base, IMAGE])
          .catch(() => docker(['start', GARAGE]).catch(() => { /* concurrently created & running */ }))
      }
    }
    await this.waitReady()
    await this.initLayout()
    this.ensured = true
  }

  private async waitReady(tries = 30): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try { await this.garage(['status']); return } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('shared Garage server never became ready')
  }

  /** Single-node layout: assign this node a role once; later calls see a role and skip.
   *
   *  The skip is decided on POSITIVE evidence now. `if (!status.includes('NO ROLE ASSIGNED'))
   *  return` read every output this parser does not understand -- a changed format, a partially
   *  written capture, an empty buffer -- as "the node already has a role", and the layout was
   *  then never initialised, on a store the daemon reports as ready. The node rows are what says
   *  anything at all: no rows means the status could not be read, and that raises rather than
   *  skipping. */
  private async initLayout(): Promise<void> {
    const status = (await this.garage(['status'])).toString()
    const rows = status.split('\n').map((l) => l.trim()).filter((l) => NODE_ROW.test(l))
    if (!rows.length) {
      throw new Error(`could not read the Garage node list from \`garage status\` (got ${JSON.stringify(status.slice(0, 200))}); refusing to assume this node already has a layout role`)
    }
    const unassigned = rows.find((l) => l.includes('NO ROLE ASSIGNED'))
    if (!unassigned) return
    const nodeId = unassigned.split(/\s+/)[0]
    await this.garage(['layout', 'assign', '-z', 'dc1', '-c', '100G', nodeId])
    await this.garage(['layout', 'apply', '--version', '1']).catch(() => { /* concurrent init won */ })
  }

  /** Key IDs (GK…) for a key NAME. Garage names aren't unique, so all key management goes
   *  through ids — never `key info <name>`, which errors as soon as a duplicate exists. */
  private async keyIds(name: string): Promise<string[]> {
    const out = (await this.garage(['key', 'list'])).toString()
    return out.split('\n')
      .map((l) => l.trim().split(/\s+/)) // columns: ID  Created  Name  Expiration
      .filter((cols) => cols[2] === name && cols[0]?.startsWith('GK'))
      .map((cols) => cols[0])
  }

  /** Create-or-fetch an access key; returns its S3 credentials. */
  private async keyCreds(name: string): Promise<{ id: string; secret: string }> {
    const parse = (raw: string): { id: string; secret: string } | null => {
      const m = /Key ID:\s+(\S+)[\s\S]*?Secret key:\s+(\S+)/.exec(raw)
      return m ? { id: m[1], secret: m[2] } : null
    }
    const existing = await this.keyIds(name)
    if (existing.length) {
      const got = parse((await this.garage(['key', 'info', existing[0], '--show-secret'])).toString())
      if (got) return got
    }
    // `key create` prints the new key's info block, secret included — parse it directly.
    const created = parse((await this.garage(['key', 'create', name])).toString())
    if (created) return created
    const ids = await this.keyIds(name)
    if (!ids.length) throw new Error(`could not read credentials for Garage key ${name}`)
    const got = parse((await this.garage(['key', 'info', ids[0], '--show-secret'])).toString())
    if (!got) throw new Error(`could not read credentials for Garage key ${name}`)
    return got
  }

  private async admin(): Promise<{ id: string; secret: string }> {
    if (!this.adminCreds) this.adminCreds = await this.keyCreds(ADMIN_KEY)
    return this.adminCreds
  }

  /** Run an rclone command in a throwaway container on `network` (so io-garage resolves). */
  private async rclone(network: string, creds: { id: string; secret: string }, args: string[], input?: Buffer): Promise<Buffer> {
    return docker(['run', '--rm', '-i', '--network', network,
      '-e', 'RCLONE_CONFIG_G_TYPE=s3', '-e', 'RCLONE_CONFIG_G_PROVIDER=Other',
      '-e', `RCLONE_CONFIG_G_ENDPOINT=http://${GARAGE}:${S3_PORT}`, '-e', 'RCLONE_CONFIG_G_REGION=garage',
      '-e', `RCLONE_CONFIG_G_ACCESS_KEY_ID=${creds.id}`, '-e', `RCLONE_CONFIG_G_SECRET_ACCESS_KEY=${creds.secret}`,
      RCLONE, ...args], { input })
  }

  async provision(ref: string, network: string, name: string): Promise<{ bucket: string; env: Record<string, string> }> {
    await this.ensure()
    // attach the shared Garage to this branch's network so the app (and rclone) can reach it
    await docker(['network', 'connect', network, GARAGE]).catch(() => { /* already attached */ })
    const bucket = bucketName(ref, name)
    await this.garage(['bucket', 'create', bucket]).catch(() => { /* exists */ })
    // grants go by key ID (names aren't unique in Garage, so a name here would break on dupes)
    const creds = await this.keyCreds(bucket)
    await this.garage(['bucket', 'allow', '--read', '--write', bucket, '--key', creds.id])
    // the internal admin key gets rw too — clone and teardown run under it
    const admin = await this.admin()
    await this.garage(['bucket', 'allow', '--read', '--write', bucket, '--key', admin.id])
    return {
      bucket,
      env: {
        AWS_ACCESS_KEY_ID: creds.id,
        AWS_SECRET_ACCESS_KEY: creds.secret,
        // Server mode: ONE string that works on the host and inside a container (decision 20) —
        // `s3.<domain>` routes to Garage, and the deploy aliases pin it to the box, so an SDK's
        // default virtual-hosted addressing (`<bucket>.s3.<domain>`) works too. Local mode keeps
        // the branch-network name; `containerize()` owns the host-facing rewrite there.
        AWS_ENDPOINT_URL_S3: this.opts.mode === 'server' ? this.opts.hostEndpoint : `http://${GARAGE}:${S3_PORT}`,
        AWS_REGION: 'garage',
        BUCKET_NAME: bucket,
      },
    }
  }

  /** Branch clone: copy every object from the source bucket into the destination bucket. */
  async cloneInto(srcBucket: string, dstBucket: string, network: string): Promise<void> {
    await this.rclone(network, await this.admin(), ['sync', `g:${srcBucket}`, `g:${dstBucket}`])
  }

  /** Bucket access mode: anonymous public-read via Garage's web endpoint (vhost per bucket,
   *  http://<bucket>.web.garage.localhost:3902 from the host) vs private. */
  async setAccess(bucket: string, _network: string, isPublic: boolean): Promise<void> {
    await this.garage(['bucket', 'website', isPublic ? '--allow' : '--deny', bucket])
  }

  /** Purge the objects, delete the bucket, drop its keys.
   *
   *  A failure here used to be indistinguishable from an empty bucket, and the caller unregisters
   *  the service on the strength of this returning: a bucket that is still there then has no row
   *  naming it and nobody will ever come back for it. So absence is ESTABLISHED before this
   *  reports success -- garage's own bucket list is asked afterwards, and a bucket still in it
   *  raises. The object purge stays best effort on its own (an empty or already-gone bucket makes
   *  rclone complain and that is not a failure), because the bucket delete below is the step that
   *  actually decides, and garage refuses to delete a bucket that still holds objects. */
  async destroy(bucket: string, network: string): Promise<void> {
    try { await this.rclone(network, await this.admin(), ['purge', `g:${bucket}`]) } catch { /* empty / gone */ }
    let failure: string | undefined
    try {
      await this.garage(['bucket', 'delete', '--yes', bucket])
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
    if (failure !== undefined && await this.bucketExists(bucket)) {
      throw new Error(`could not delete bucket ${bucket}: ${failure}`)
    }
    for (const id of await this.keyIds(bucket).catch(() => [] as string[])) {
      await this.garage(['key', 'delete', '--yes', id]).catch(() => { /* gone */ })
    }
  }

  /** Is the bucket still there? A LIST that cannot answer is not evidence of absence, so it
   *  answers "still there" and the caller keeps its row. */
  private async bucketExists(bucket: string): Promise<boolean> {
    try {
      const out = (await this.garage(['bucket', 'list'])).toString()
      return out.split('\n').some((l) => l.split(/\s+/).includes(bucket))
    } catch {
      return true
    }
  }

  /** Detach the shared Garage from a branch network. This belongs to the BRANCH, not to a bucket:
   *  every storage service on a branch shares one network, so disconnecting when a single bucket is
   *  destroyed would cut S3 for the others (and would strand the rclone purge of the next bucket in
   *  a teardown). Callers detach once, after the last bucket on that network is gone. */
  async detachFrom(network: string): Promise<void> {
    await docker(['network', 'disconnect', network, GARAGE]).catch(() => { /* not attached */ })
  }

  // ---- object operations (platform parity: `insta storage` + the console's file browser) ----
  // The daemon runs on the HOST, and so do the CLI/browser that consume presigned URLs, so both
  // the daemon's own S3 calls and every URL it signs go through Garage's host endpoint
  // (cfg.s3HostEndpoint: 127.0.0.1:3900, published best-effort at server start), NOT the
  // branch-network name io-garage. SigV4 signs the Host header, so the two are not interchangeable.
  private hostCreds(env: Record<string, string>): S3Creds {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION ?? 'garage',
      endpoint: this.opts.hostEndpoint,
    }
  }

  private async s3Fetch(req: { url: string; headers: Record<string, string> }, method: string, body?: Buffer): Promise<string> {
    let res: Response
    try { res = await fetch(req.url, { method, headers: req.headers, body: body as BodyInit | undefined }) }
    catch {
      throw new Error(`could not reach Garage on its host port (${this.opts.hostEndpoint}) — it is published best-effort at daemon start; free the port and restart, or set INSTA_OSS_S3_HOST_ENDPOINT`)
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Garage answered ${res.status}: ${/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200)}`)
    return text
  }

  async listBucketObjects(env: Record<string, string>, opts: { prefix?: string; cursor?: string; limit: number }): Promise<ObjectListing> {
    const creds = this.hostCreds(env)
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(opts.limit) }
    if (opts.prefix) query.prefix = opts.prefix
    if (opts.cursor) query['continuation-token'] = opts.cursor
    const xml = await this.s3Fetch(signRequest(creds, 'GET', `/${env.BUCKET_NAME}`, query, null), 'GET')
    return parseListObjects(xml)
  }

  async presignObjectGet(env: Record<string, string>, key: string, disposition: 'attachment' | 'inline'): Promise<{ url: string; expiresAt: string }> {
    // Short TTL: the link is handed to a browser (cloud contract: 60s).
    return presignGet(this.hostCreds(env), `/${env.BUCKET_NAME}/${key}`, 60, { 'response-content-disposition': disposition })
  }

  async presignObjectPost(env: Record<string, string>, key: string, contentType: string, size: number): Promise<{ url: string; fields: Record<string, string>; expiresAt: string }> {
    // Longer than a download's: an upload takes minutes, not one click (cloud contract: 300s).
    return presignPost(this.hostCreds(env), env.BUCKET_NAME, key, contentType, size, 300)
  }

  async removeObject(env: Record<string, string>, key: string): Promise<void> {
    await this.s3Fetch(signRequest(this.hostCreds(env), 'DELETE', `/${env.BUCKET_NAME}/${key}`, {}, null), 'DELETE')
  }

  async removeObjects(env: Record<string, string>, keys: string[]): Promise<{ deleted: number; failed: Array<{ key: string; message: string }> }> {
    const body = Buffer.from(`<Delete>${keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')}</Delete>`)
    const md5 = createHash('md5').update(body).digest('base64') // DeleteObjects requires Content-MD5
    const req = signRequest(this.hostCreds(env), 'POST', `/${env.BUCKET_NAME}`, { delete: '' }, body, { 'content-md5': md5 })
    return parseDeleteResult(await this.s3Fetch(req, 'POST', body))
  }

  // Test helpers (also handy for debugging): put/get/list objects via rclone, by bucket handle.
  putObject(network: string, bucket: string, key: string, body: string): Promise<Buffer> {
    return this.admin().then((c) => this.rclone(network, c, ['rcat', `g:${bucket}/${key}`], Buffer.from(body)))
  }
  async getObject(network: string, bucket: string, key: string): Promise<string> {
    return (await this.rclone(network, await this.admin(), ['cat', `g:${bucket}/${key}`])).toString()
  }
  async listObjects(network: string, bucket: string): Promise<string> {
    return (await this.rclone(network, await this.admin(), ['ls', `g:${bucket}`])).toString()
  }
}
