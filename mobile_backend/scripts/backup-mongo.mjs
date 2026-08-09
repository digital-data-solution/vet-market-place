// ─────────────────────────────────────────────────────────────────────────────
// Weekly MongoDB backup — free, no external tools, READ-ONLY.
//
// Exports every collection to EJSON (preserves ObjectId/Date so it can be
// restored) into a timestamped folder, then prunes to the most recent N backups
// to keep disk/OneDrive usage in check.
//
// Run manually:  node scripts/backup-mongo.mjs
// Runs automatically via the Windows Scheduled Task "XpressVet Weekly DB Backup".
//
// Output goes to OneDrive so each backup is synced off this machine for free.
// Override the destination with the BACKUP_DIR env var if you like.
// ─────────────────────────────────────────────────────────────────────────────
import { MongoClient } from 'mongodb';
import { EJSON } from 'bson';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

const KEEP = parseInt(process.env.BACKUP_KEEP || '8', 10); // keep last 8 weekly backups (~2 months)
const BASE = process.env.BACKUP_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'OneDrive', 'vetfresh-backups');

function getUri() {
  const env = readFileSync(path.join(BACKEND_DIR, '.env'), 'utf8');
  const m = env.match(/^MONGODB_URI=(.*)$/m);
  if (!m) throw new Error('MONGODB_URI not found in mobile_backend/.env');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function prune() {
  try {
    const dirs = readdirSync(BASE)
      .filter((d) => d.startsWith('vetfresh-backup-'))
      .map((d) => ({ d, t: statSync(path.join(BASE, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of dirs.slice(KEEP)) {
      rmSync(path.join(BASE, old.d), { recursive: true, force: true });
      console.log('  pruned old backup:', old.d);
    }
  } catch (e) { console.warn('prune skipped:', e.message); }
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
const outDir = path.join(BASE, `vetfresh-backup-${stamp}`);

const client = new MongoClient(getUri());
try {
  mkdirSync(outDir, { recursive: true });
  await client.connect();
  const db = client.db();
  console.log('Backing up database:', db.databaseName, '→', outDir);
  const cols = await db.listCollections().toArray();
  let total = 0; const summary = [];
  for (const c of cols) {
    const docs = await db.collection(c.name).find({}).toArray();
    writeFileSync(path.join(outDir, `${c.name}.json`), EJSON.stringify(docs, null, 2));
    total += docs.length; summary.push(`${c.name}: ${docs.length}`);
  }
  writeFileSync(path.join(outDir, '_manifest.txt'),
    `Xpress Vet MongoDB backup\nDatabase: ${db.databaseName}\nDate: ${new Date().toISOString()}\nCollections: ${cols.length}\nTotal documents: ${total}\n\n${summary.join('\n')}\n`);
  console.log(`DONE — ${cols.length} collections, ${total} docs`);
  prune();
} catch (e) {
  console.error('BACKUP FAILED:', e.message);
  process.exit(1);
} finally {
  await client.close();
}
