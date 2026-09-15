#!/usr/bin/env node
/**
 * One-shot Cloudflare provisioning.
 *
 * Creates the D1 database and R2 bucket, writes the resulting database_id into
 * wrangler.jsonc, and applies the migrations to the remote database. Safe to
 * re-run: every step checks for an existing resource first, so running it twice
 * does nothing the second time.
 *
 * Authentication is deliberately NOT handled here. `wrangler login` opens a
 * browser and authorises against a real Cloudflare account -- that is the
 * account owner's action to take, not a build script's, and the brief is
 * explicit that no API token should be requested or hardcoded.
 *
 *   npx wrangler login          # once, by you
 *   npm run setup:cloudflare    # this script
 *   npm run deploy
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(root, 'wrangler.jsonc');

const DB_NAME = 'idrift-db';
const BUCKET_NAME = 'idrift-media';

function wrangler(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (err) {
    if (allowFailure) return (err.stdout ?? '') + (err.stderr ?? '');
    console.error(`\nwrangler ${args.join(' ')} failed:\n`);
    console.error((err.stdout ?? '') + (err.stderr ?? ''));
    process.exit(1);
  }
}

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

// --- Authentication ---------------------------------------------------------

step('Checking authentication');
const who = wrangler(['whoami'], { allowFailure: true });
if (/not authenticated/i.test(who)) {
  console.error(
    '\nNot logged in to Cloudflare.\n\n' +
      '  Run `npx wrangler login` first — it opens a browser and asks you to\n' +
      '  authorise Wrangler against your account. This script deliberately does\n' +
      '  not do that for you, and never asks for an API token.\n',
  );
  process.exit(1);
}
console.log(who.trim().split('\n').slice(-3).join('\n'));

// --- D1 ---------------------------------------------------------------------

step(`Creating D1 database "${DB_NAME}"`);
const dbList = wrangler(['d1', 'list', '--json'], { allowFailure: true });
let databaseId = null;
try {
  const existing = JSON.parse(dbList).find((d) => d.name === DB_NAME);
  if (existing) {
    databaseId = existing.uuid ?? existing.database_id;
    console.log(`  already exists (${databaseId})`);
  }
} catch {
  // `d1 list` returned something that is not JSON; fall through to create.
}

if (!databaseId) {
  const created = wrangler(['d1', 'create', DB_NAME]);
  // Wrangler prints the binding snippet; pull the uuid out of it.
  const match = created.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)
    ?? created.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i)
    ?? created.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!match) {
    console.error('Could not find the database id in wrangler output:\n', created);
    process.exit(1);
  }
  databaseId = match[1];
  console.log(`  created (${databaseId})`);
}

step('Writing database_id into wrangler.jsonc');
const config = readFileSync(CONFIG, 'utf8');
const updated = config.replace(
  /("database_id"\s*:\s*")[^"]*(")/,
  `$1${databaseId}$2`,
);
if (updated === config && !config.includes(databaseId)) {
  console.error('  could not substitute database_id — check wrangler.jsonc by hand');
  process.exit(1);
}
writeFileSync(CONFIG, updated);
console.log('  done');

// --- R2 ---------------------------------------------------------------------

step(`Creating R2 bucket "${BUCKET_NAME}"`);
const buckets = wrangler(['r2', 'bucket', 'list'], { allowFailure: true });
if (buckets.includes(BUCKET_NAME)) {
  console.log('  already exists');
} else {
  const result = wrangler(['r2', 'bucket', 'create', BUCKET_NAME], { allowFailure: true });
  if (/enable R2|code: 10042/i.test(result)) {
    // R2 needs a one-time account-level opt-in. Not fatal: nothing reads the
    // bucket yet, and the binding is commented out in wrangler.jsonc until it
    // exists. Warn and carry on rather than blocking the whole deploy on an
    // asset store with no assets in it.
    console.log('  SKIPPED — R2 is not enabled on this account.');
    console.log('    Enable it at dash.cloudflare.com → R2, then re-run this script');
    console.log('    and uncomment the r2_buckets binding in wrangler.jsonc.');
  } else if (/error/i.test(result) && !/created/i.test(result)) {
    console.error(result);
    process.exit(1);
  } else {
    console.log('  created');
  }
}

// --- Migrations -------------------------------------------------------------

step('Applying migrations to the remote database');
console.log(wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']).trim());

// The LOCAL database has to be migrated too, and it is easy to miss why.
// Wrangler keys local D1 state by database_id, so writing the real id into
// wrangler.jsonc above silently repoints local dev at a brand new, empty
// database. Every API call then fails with a bare 500 ("no such table") and
// nothing on screen connects that to having run this script.
step('Applying migrations to the local development database');
console.log(wrangler(['d1', 'migrations', 'apply', DB_NAME, '--local']).trim());

// --- Done -------------------------------------------------------------------

console.log(`
▸ Ready.

  Deploy with:      npm run deploy
  Wipe the board:   npm run db:reset

  The leaderboard partitions on simVersion, so bumping SIM_VERSION after a
  physics change starts a clean board without touching the old rows.
`);
