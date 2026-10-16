/*
 * Replaces the admin credential Umami seeds with the one the operator deployed with.
 *
 * Umami has no sign-up page. Its first migration (prisma/migrations/01_init/migration.sql) inserts
 * one row into "user": username `admin`, role `admin`, and the bcrypt hash of the password
 * `umami`, which is in the public repository. On a URL anyone can reach that is not a credential to
 * leave in place, and upstream exposes no environment variable for it, so the entrypoint writes it
 * here before the server starts listening.
 *
 * Runs on every boot and acts only while the account is still at that factory default, so a
 * password changed in Umami's own UI is not reset by a restart.
 */
const { Client } = require('/insta/node_modules/pg');
const bcrypt = require('/insta/node_modules/bcryptjs');

// The row the migration inserts, matched by id: a username is the thing this script may change.
const SEEDED_USER_ID = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
const SEEDED_PASSWORD = 'umami';
const BCRYPT_ROUNDS = 10; // SALT_ROUNDS in src/lib/password.ts, so the hash matches what Umami writes

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are both required');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query('select username, password from "user" where user_id = $1', [
      SEEDED_USER_ID,
    ]);

    if (!rows.length) {
      console.log('Admin: the seeded account is gone, leaving accounts alone.');
      return;
    }

    if (!bcrypt.compareSync(SEEDED_PASSWORD, rows[0].password)) {
      console.log(`Admin: '${rows[0].username}' is no longer on the seeded password, leaving it alone.`);
      return;
    }

    await client.query(
      'update "user" set username = $1, password = $2, updated_at = now() where user_id = $3',
      [username, bcrypt.hashSync(password, BCRYPT_ROUNDS), SEEDED_USER_ID],
    );

    console.log(`✓ Admin account set to '${username}'.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`✗ Unable to set the admin account: ${e.message}`);
  // Exiting non-zero rather than carrying on: starting anyway would publish a server whose admin
  // password is the one printed in upstream's migration.
  process.exit(1);
});
