import { describe, expect, it } from 'vitest'
import {
  connectUrlFor, dbRawCommand, instaCliRun, isDbConnectEngine, maskDsn, mongoshCommand, mysqlCommand, psqlCommand,
  redisCliCommand, shellQuote,
} from './databaseConnect'

describe('connectUrlFor', () => {
  it("reads each engine's own URL credential", () => {
    expect(connectUrlFor('postgres', { DATABASE_URL: 'postgres://a:b@h:1/d', REDIS_URL: 'x' })).toBe('postgres://a:b@h:1/d')
    expect(connectUrlFor('redis', { REDIS_URL: 'redis://default:pw@127.0.0.1:6380/0', REDIS_HOST: '127.0.0.1' })).toBe('redis://default:pw@127.0.0.1:6380/0')
    expect(connectUrlFor('mysql', { MYSQL_URL: 'mysql://insta:pw@127.0.0.1:3307/app' })).toBe('mysql://insta:pw@127.0.0.1:3307/app')
    expect(connectUrlFor('mongodb', { MONGODB_URL: 'mongodb://root:pw@127.0.0.1:27018/admin' })).toBe('mongodb://root:pw@127.0.0.1:27018/admin')
  })
  it('answers null for a bundle without it', () => {
    expect(connectUrlFor('redis', { DATABASE_URL: 'postgres://x' })).toBeNull()
    expect(connectUrlFor('postgres', {})).toBeNull()
    expect(connectUrlFor('postgres', null)).toBeNull()
  })
})

describe('maskDsn', () => {
  it('hides the password and leaves everything else', () => {
    expect(maskDsn('postgres://app:s3cret@127.0.0.1:5433/app')).toBe('postgres://app:•••••••@127.0.0.1:5433/app')
    expect(maskDsn('redis://127.0.0.1:6379')).toBe('redis://127.0.0.1:6379')
    expect(maskDsn('not a url')).toBe('•••••••')
  })
})

describe('client commands', () => {
  it('psql keeps the password in PGPASSWORD, masked in the visible form', () => {
    expect(psqlCommand('postgres://app:p%40ss@127.0.0.1:5433/shop')).toEqual({
      full: "PGPASSWORD='p@ss' psql -h 127.0.0.1 -p 5433 -U app -d shop",
      masked: 'PGPASSWORD=••••••• psql -h 127.0.0.1 -p 5433 -U app -d shop',
    })
    expect(psqlCommand('postgres://app@127.0.0.1/')?.full).toBe('psql -h 127.0.0.1 -p 5432 -U app -d app')
    expect(psqlCommand('nope')).toBeNull()
  })
  it('mysql keeps the password in MYSQL_PWD', () => {
    expect(mysqlCommand('mysql://root:pw@127.0.0.1:3307/app')).toEqual({
      full: "MYSQL_PWD='pw' mysql -h 127.0.0.1 -P 3307 -u root app",
      masked: 'MYSQL_PWD=••••••• mysql -h 127.0.0.1 -P 3307 -u root app',
    })
  })
  it('redis-cli and mongosh take the URL as one quoted token, masked', () => {
    expect(redisCliCommand('redis://default:pw@127.0.0.1:6380')).toEqual({
      full: "redis-cli -u 'redis://default:pw@127.0.0.1:6380'",
      masked: "redis-cli -u 'redis://default:•••••••@127.0.0.1:6380'",
    })
    expect(mongoshCommand('mongodb://u:pw@127.0.0.1:27018/db')?.masked).toBe("mongosh 'mongodb://u:•••••••@127.0.0.1:27018/db'")
    expect(dbRawCommand('redis', 'redis://127.0.0.1:6379')?.full).toBe("redis-cli -u 'redis://127.0.0.1:6379'")
  })
  it('quotes for the shell and wraps in insta run', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(instaCliRun('main', 'psql -h h')).toBe("insta run --branch 'main' -- sh -c 'psql -h h'")
  })
  it('knows which service types are databases', () => {
    expect(['postgres', 'mysql', 'redis', 'mongodb'].every(isDbConnectEngine)).toBe(true)
    expect(isDbConnectEngine('compute')).toBe(false)
    expect(isDbConnectEngine('storage')).toBe(false)
  })
})
