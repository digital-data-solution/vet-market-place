// READ-ONLY report: visits to the public vet pages and Call/WhatsApp taps per vet.
//   node scripts/public-page-stats.mjs            (last 30 days)
//   node scripts/public-page-stats.mjs 7          (last 7 days)
import 'dotenv/config';
import mongoose from 'mongoose';
import PublicPageEvent from '../src/models/PublicPageEvent.js';
import { PUBLIC_VETS } from '../src/config/publicVets.js';

const days = Number(process.argv[2]) || 30;
const since = new Date(Date.now() - days * 24 * 3600 * 1000);

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const names = new Map(
  (await mongoose.connection.db.collection('professionals')
    .find({ _id: { $in: PUBLIC_VETS.map((v) => new mongoose.Types.ObjectId(v.id)) } }, { projection: { businessName: 1 } })
    .toArray()).map((d) => [String(d._id), d.businessName]),
);

const rows = await PublicPageEvent.aggregate([
  { $match: { createdAt: { $gte: since } } },
  { $group: { _id: { kind: '$kind', path: '$path', vetId: '$vetId', src: '$src' }, n: { $sum: 1 } } },
]);

const sum = (f) => rows.filter(f).reduce((a, r) => a + r.n, 0);
console.log(`Public vet pages, last ${days} days (since ${since.toISOString().slice(0, 10)})\n`);

console.log('Page views by source:');
const bySrc = {};
for (const r of rows.filter((x) => x._id.kind === 'view')) bySrc[r._id.src] = (bySrc[r._id.src] || 0) + r.n;
for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(10)} ${n}`);

console.log('\nTop pages:');
const byPath = {};
for (const r of rows.filter((x) => x._id.kind === 'view')) {
  const p = r._id.vetId ? `/v/${names.get(r._id.vetId) || r._id.vetId}` : r._id.path;
  byPath[p] = (byPath[p] || 0) + r.n;
}
for (const [p, n] of Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${p}`);

console.log('\nFarmer contacts per vet (taps on Call / WhatsApp):');
for (const v of PUBLIC_VETS) {
  const mine = (k) => sum((r) => r._id.vetId === v.id && r._id.kind === k);
  const views = mine('view');
  const call = mine('call');
  const wa = mine('whatsapp');
  const srcs = {};
  for (const r of rows.filter((x) => x._id.vetId === v.id && x._id.kind !== 'view')) srcs[r._id.src] = (srcs[r._id.src] || 0) + r.n;
  const from = Object.entries(srcs).map(([s, n]) => `${s} ${n}`).join(', ');
  console.log(`  ${(names.get(v.id) || v.id).slice(0, 38).padEnd(38)} ${v.state.padEnd(7)} views ${views}  call ${call}  whatsapp ${wa}${from ? `  (from: ${from})` : ''}`);
}
await mongoose.disconnect();
