/**
 * scheduleYouTubeShorts.mjs — uploads the YouTube versions of the vet-tip
 * videos (VETFRESH/instagram-videos/out/youtube, rendered with
 * PLATFORM=youtube for the subscribe end card) to Cloudinary and (re)writes
 * their YouTubeShort rows. youtube-shorts-worker.yml then uploads them to the
 * channel as private + publishAt.
 *
 *   node scripts/scheduleYouTubeShorts.mjs              → every rendered video
 *   node scripts/scheduleYouTubeShorts.mjs t1-...       → just these
 *
 * Titles and tags use the phrases Nigerian viewers actually search (trend scan
 * 2026-10-02). Re-running is safe: rows already uploaded are never touched.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { default: YouTubeShort } = await import('../src/models/YouTubeShort.js');
const { uploadVideoToCloudinary } = await import('../src/lib/cloudinaryUpload.js');

const OUT = process.env.REELS_OUT || path.join(__dirname, '..', '..', '..', 'instagram-videos', 'out', 'youtube');
const SITE = 'https://go.xpressvetmarketplace.com';
const ACADEMY = 'https://xpress-academy-web.onrender.com/courses';
const SUBSCRIBE = 'https://www.youtube.com/channel/UC7DfpET-YsSQVXsil5-bEyA?sub_confirmation=1';

const POULTRY_TAGS = ['poultry farming nigeria', 'poultry farming', 'broiler farming', 'chicken disease', 'poultry disease treatment', 'nigerian vet', 'xpress vet'];
const PET_TAGS = ['dog care nigeria', 'dogs in nigeria', 'pet care', 'vet tips', 'nigerian vet', 'xpress vet'];

// Daily at 18:00 WAT (17:00 UTC) — weekday engagement peak for a Nigerian
// audience. Trending poultry topics alternate with the proven pet tips.
const SHORTS = [
  { key: 't1-christmas-broilers', day: '2026-10-04', farm: true,
    title: 'Christmas Broilers 2026: When to Buy Day-Old Chicks | Poultry Farming Nigeria',
    course: ['brooding-day-old-chicks', 'Brooding Day-Old Chicks'], tags: ['christmas broilers', 'day old chicks', 'broiler farming nigeria'] },
  { key: '01-mange-ringworm', day: '2026-10-05',
    title: 'Ringworm or Mange? Bald Patches on Your Dog | Nigerian Vet',
    course: ['common-skin-disorders-in-dogs', 'Common Skin Disorders in Dogs'], tags: ['dog mange', 'ringworm in dogs', 'dog skin disease'] },
  { key: 't2-christmas-diseases', day: '2026-10-06', farm: true,
    title: '3 Poultry Diseases That Kill Christmas Birds | Newcastle, Gumboro, Coccidiosis',
    course: ['newcastle-disease-in-poultry', 'Newcastle Disease in Poultry'], atlas: true,
    tags: ['newcastle disease', 'gumboro disease', 'coccidiosis in chickens'] },
  { key: '04-parvo-one-injection', day: '2026-10-07',
    title: 'Puppy Parvo: Why ONE Vaccine Injection Is Not Enough',
    course: ['canine-parvovirus', 'Canine Parvovirus'], tags: ['puppy parvo', 'parvovirus in dogs', 'puppy vaccination'] },
  { key: 't3-harmattan', day: '2026-10-08', farm: true,
    title: 'Harmattan Poultry Tips: Protect Your Broilers & Layers | Nigerian Vet',
    course: ['mycoplasmosis-crd-in-poultry', 'Mycoplasmosis (CRD) in Poultry'], tags: ['harmattan poultry', 'crd in chickens', 'layers farming'] },
  { key: '05-dog-bite', day: '2026-10-09',
    title: 'Dog Bite in Nigeria? Rabies First Aid: Wash, Hospital, Observe',
    course: ['canine-rabies-prevention-exposure-protocol', 'Canine Rabies: Prevention & Exposure Protocol'], tags: ['rabies', 'dog bite', 'rabies nigeria'] },
  { key: 't5-egg-drop', day: '2026-10-10', farm: true,
    title: 'Layers Egg Production Dropping? Check These 4 Things | Nigerian Vet',
    course: ['egg-production-problems', 'Egg Production Problems'], tags: ['egg production drop', 'layers farming nigeria', 'laying hens'] },
  { key: '02-bloat', day: '2026-10-11',
    title: 'Dog Bloat (GDV): Swollen Belly + Retching = Emergency',
    course: ['gastric-dilatation-volvulus-bloat', 'Gastric Dilatation-Volvulus (Bloat)'], tags: ['dog bloat', 'gdv in dogs', 'boerboel'] },
  { key: 't4-bird-flu', day: '2026-10-12', farm: true,
    title: 'Bird Flu in Nigeria: How to Protect Your Poultry Farm',
    course: ['poultry-biosecurity-checklist', 'Biosecurity on a Poultry Farm'], tags: ['bird flu nigeria', 'avian influenza', 'poultry biosecurity'] },
  { key: '06-newcastle', day: '2026-10-13', farm: true,
    title: 'Newcastle Disease Signs: Twisted Necks & Egg Drop | Poultry Farming Nigeria',
    course: ['newcastle-disease-in-poultry', 'Newcastle Disease in Poultry'], atlas: true, tags: ['newcastle disease', 'twisted neck chicken'] },
  { key: '07-paracetamol-myth', day: '2026-10-14',
    title: 'Never Give Your Cat Paracetamol | Cat Poisoning Warning', tags: ['cat poisoning', 'cats nigeria', 'cat health'] },
  { key: '10-heat-stress', day: '2026-10-15', farm: true,
    title: 'Heat Stress in Layers: 3 Fixes for Fewer Eggs in Hot Weather',
    course: ['poultry-heat-stress-management', 'Heat Stress Management in Poultry'], tags: ['heat stress in poultry', 'layers farming'] },
  { key: '03-cat-flu', day: '2026-10-16',
    title: 'Why Cat Flu Keeps Coming Back | Cat Sneezing & Runny Eyes',
    course: ['feline-upper-respiratory-infections', 'Feline Upper Respiratory Infections'], tags: ['cat flu', 'cat sneezing', 'cat health'] },
  { key: '08-palm-oil-myth', day: '2026-10-17',
    title: 'Pet Poisoning? Palm Oil Is a Myth — Bring the Packet to the Vet', tags: ['dog poisoning', 'palm oil myth', 'pet first aid'] },
  { key: '11-five-emergency-signs', day: '2026-10-18',
    title: '5 Signs Your Dog or Cat Needs a Vet NOW', tags: ['pet emergency', 'sick dog signs', 'sick cat signs'] },
  { key: '09-ticks-indoors', day: '2026-10-19',
    title: 'Indoor Dogs Get Ticks Too | Tick Fever Prevention',
    course: ['ehrlichiosis-tick-borne-disease-dogs', 'Ehrlichiosis and Tick-Borne Disease in Dogs'], tags: ['ticks on dogs', 'tick fever', 'ehrlichiosis'] },
];

const hashtags = (txt) => (txt.match(/^#.+$/m) || [''])[0];

function description(s) {
  const txt = fs.readFileSync(path.join(OUT, `${s.key}.txt`), 'utf8');
  const [hook, , question] = txt.split('\n');
  const credits = (txt.match(/^Credits: .+$/m) || [''])[0];
  return [
    hook,
    '',
    question,
    '',
    `🔔 Subscribe for free vet tips from a Nigerian vet: ${SUBSCRIBE}`,
    `👍 Like and share with a ${s.farm ? 'poultry farmer' : 'pet owner'} who needs this.`,
    '📸 Follow us on Instagram: https://www.instagram.com/xpress_vet',
    '',
    `📍 ${s.farm ? 'Need a poultry vet?' : 'Need a vet?'} Find one near you (free account): ${SITE}/professionals?src=yt`,
    `📖 Free guides: ${SITE}/Blog?src=yt`,
    ...(s.course ? [`📚 Go deeper: "${s.course[1]}" — short PAID course on Xpress Academy (price shown before you pay): ${ACADEMY}/${s.course[0]}/`] : []),
    ...(s.atlas ? [`🩺 For vets: "Poultry Post-Mortem Diagnosis: The Complete Field Atlas" (PAID course, lesson 4 is a FREE preview): ${ACADEMY}/poultry-post-mortem-diagnosis-atlas/`] : []),
    '🩺 Vets: get listed free on Xpress Vet: ' + `${SITE}/auth/register?src=yt`,
    '',
    'By a Nigerian vet at Xpress Vet. General education only — not a substitute for a vet examining your animal.',
    '🎙️ Narrated with an AI voice.',
    credits,
    '',
    `${hashtags(txt)} #Shorts`,
  ].join('\n');
}

await connectDB();
const only = new Set(process.argv.slice(2));
for (const s of SHORTS) {
  if (only.size && !only.has(s.key)) continue;
  const file = path.join(OUT, `${s.key}.mp4`);
  if (!fs.existsSync(file)) { console.log(`${s.key}: not rendered yet — skipped`); continue; }
  const existing = await YouTubeShort.findOne({ key: s.key });
  if (existing && existing.status === 'uploaded') { console.log(`${s.key}: already on YouTube — left alone`); continue; }
  const { url } = await uploadVideoToCloudinary(file, { folder: 'youtube-shorts', publicId: s.key });
  const publishAt = new Date(`${s.day}T17:00:00Z`);
  const tags = [...new Set([...(s.tags || []), ...(s.farm ? POULTRY_TAGS : PET_TAGS)])];
  await YouTubeShort.findOneAndUpdate(
    { key: s.key },
    { $set: { videoUrl: url, title: s.title, description: description(s), tags, publishAt, status: 'pending', error: null } },
    { upsert: true },
  );
  console.log(`${s.key}: scheduled ${s.day} 18:00 WAT  ${url}`);
}
process.exit(0);
