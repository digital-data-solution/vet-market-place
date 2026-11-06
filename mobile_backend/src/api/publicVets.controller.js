/**
 * Public, no-login vet pages for farmers and pet owners:
 *   GET /v/:id                      one vet
 *   GET /vets                       states that have vets
 *   GET /vets/:state?treats=poultry one state, optionally filtered
 *
 * The app's own profile pages need a login, an email address and a one-time
 * free view, which stops most people arriving from a WhatsApp link. These pages
 * are server-rendered, like /l/:id and /b/:slug, and only ever show vets listed
 * in config/publicVets.js. They never show a personal name, VCN, email or
 * street address.
 */
import Professional from '../models/Professional.js';
import { PUBLIC_VETS, NIGERIAN_STATES } from '../config/publicVets.js';
import logger from '../lib/logger.js';

const WEB_APP_ORIGIN = process.env.WEB_APP_ORIGIN || 'https://xpressvetmarketplace.com';
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const TREATS = { poultry: 'poultry', pets: 'dogs, cats and other pets' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Stored text can already hold HTML entities ("Livestock &amp; Farm Animals").
const decodeEntities = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export const stateSlug = (name) => String(name).trim().toLowerCase().replace(/\s+/g, '-');

/** What a vet says they treat, read from the free-text specialization. */
export function treatsFrom(specialization) {
  const text = decodeEntities(specialization);
  const out = [];
  if (/poultry/i.test(text)) out.push('poultry');
  if (/small animal|\bdogs?\b|\bcats?\b|\bpets?\b/i.test(text)) out.push('pets');
  if (/livestock|large animal/i.test(text)) out.push('farm');
  return out;
}

/** Nigerian phone number → international digits, or null if it doesn't look valid. */
export function internationalPhone(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) digits = `234${digits.slice(1)}`;
  return /^234[789]\d{9}$/.test(digits) ? digits : null;
}

const TREAT_LABELS = { poultry: 'Poultry', pets: 'Dogs, cats and pets', farm: 'Livestock and farm animals' };

function vetCard(vet) {
  const whatsappText = encodeURIComponent('Good day Doctor, I found you on Xpress Vet and I need help with my animals.');
  const treats = vet.treats.map((t) => TREAT_LABELS[t]).join(' · ') || 'General veterinary practice';
  const buttons = vet.phone
    ? `<div class="btns"><a class="btn call" href="tel:+${vet.phone}">Call</a><a class="btn wa" href="https://wa.me/${vet.phone}?text=${whatsappText}">WhatsApp</a></div>`
    : '<p class="muted">Phone number not available.</p>';
  return `<section class="card"><h2>${esc(vet.title)}</h2><p class="town">${esc(vet.town)}, ${esc(vet.state)}</p><p>${esc(treats)}</p>${buttons}</section>`;
}

function page({ title, description, body }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(WEB_APP_ORIGIN)}/favicon.png">
<style>
body{margin:0;background:#f6f7f9;color:#1c2430;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px}
.brand{font-weight:700;color:#e8610a;text-decoration:none}
h1{font-size:24px;line-height:1.25;margin:12px 0 4px}
h2{font-size:18px;margin:0 0 2px}
p{margin:4px 0}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:14px;margin:12px 0}
.town,.muted{color:#5b6573}
.btns{display:flex;gap:8px;margin-top:10px}
.btn{flex:1;text-align:center;padding:12px;border-radius:8px;color:#fff;font-weight:700;text-decoration:none}
.call{background:#2563eb}.wa{background:#128c4a}
.filters a,.states a{display:inline-block;margin:4px 6px 4px 0;padding:8px 12px;background:#fff;border:1px solid #d5d9df;border-radius:8px;color:#1c2430;text-decoration:none}
.filters a.on{background:#1c2430;color:#fff;border-color:#1c2430}
footer{margin-top:20px;font-size:14px;color:#5b6573}
footer a{color:#2563eb}
</style></head><body><main>
<a class="brand" href="${esc(WEB_APP_ORIGIN)}">Xpress Vet</a>
${body}
<footer>
<p>No login needed. Xpress Vet is a directory: please agree the service and any fee directly with the vet.</p>
<p><a href="/vets">See all states</a> · <a href="${esc(WEB_APP_ORIGIN)}/auth/register">Are you a vet? Get listed</a></p>
</footer>
</main></body></html>`;
}

/**
 * @param {object}   [deps]
 * @param {Array}    [deps.publicVets]  the consent list
 * @param {Function} [deps.findVets]    (ids) => professional docs; replaced in tests
 */
export function createPublicVetHandlers({ publicVets = PUBLIC_VETS, findVets = defaultFindVets } = {}) {
  // Eligibility is enforced on every request: a vet who loses verification or
  // stops taking clients disappears even if still on the consent list.
  async function loadVets(entries) {
    if (!entries.length) return [];
    const docs = await findVets(entries.map((e) => e.id));
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return entries.flatMap((entry) => {
      const doc = byId.get(entry.id);
      if (!doc || doc.role !== 'vet' || !doc.isVerified || doc.acceptingClients === false) return [];
      return [{
        id: entry.id,
        state: entry.state,
        town: entry.town,
        title: decodeEntities(doc.businessName) || `Vet in ${entry.town}`,
        treats: entry.treats ?? treatsFrom(doc.specialization),
        phone: internationalPhone(doc.phone || doc.userId?.phone),
      }];
    });
  }

  const sendHtml = (res, html) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Robots-Tag', 'noindex');
    return res.send(html);
  };

  const sendError = (res, err) => {
    logger.error('Public vet page error', { error: err.message });
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(page({
      title: 'Please try again',
      description: 'Xpress Vet',
      body: '<h1>Please try again</h1><p>We could not load this page just now.</p>',
    }));
  };

  async function vetPage(req, res) {
    const { id } = req.params;
    const fallback = OBJECT_ID.test(id)
      ? `${WEB_APP_ORIGIN}/VetProfile?vetId=${encodeURIComponent(id)}`
      : WEB_APP_ORIGIN;
    try {
      const entry = publicVets.find((e) => e.id === id);
      const [vet] = entry ? await loadVets([entry]) : [];
      if (!vet) return res.redirect(302, fallback);
      return sendHtml(res, page({
        title: `${vet.title} — vet in ${vet.town}, ${vet.state}`,
        description: `Call or WhatsApp ${vet.title} in ${vet.town}. No login needed.`,
        body: `<h1>Vet in ${esc(vet.town)}</h1>${vetCard(vet)}`,
      }));
    } catch (err) {
      return sendError(res, err);
    }
  }

  async function statesIndex(req, res) {
    try {
      const vets = await loadVets(publicVets);
      const counts = new Map();
      for (const v of vets) counts.set(v.state, (counts.get(v.state) || 0) + 1);
      const links = [...counts.keys()].sort()
        .map((s) => `<a href="/vets/${esc(stateSlug(s))}">${esc(s)} (${counts.get(s)})</a>`)
        .join('');
      return sendHtml(res, page({
        title: 'Find a vet in Nigeria by state — Xpress Vet',
        description: 'Choose your state and call or WhatsApp a vet. No login needed.',
        body: `<h1>Find a vet by state</h1><div class="states">${links || '<p>No vets are listed here yet.</p>'}</div>`,
      }));
    } catch (err) {
      return sendError(res, err);
    }
  }

  async function statePage(req, res) {
    const stateName = NIGERIAN_STATES.find((s) => stateSlug(s) === req.params.state.toLowerCase());
    if (!stateName) return res.redirect(302, '/vets');
    const treats = Object.hasOwn(TREATS, req.query.treats) ? req.query.treats : null;
    try {
      const inState = await loadVets(publicVets.filter((e) => e.state === stateName));
      const vets = treats ? inState.filter((v) => v.treats.includes(treats)) : inState;
      const base = `/vets/${stateSlug(stateName)}`;
      const filter = (href, label, on) => `<a class="${on ? 'on' : ''}" href="${href}">${label}</a>`;
      const heading = treats ? `Vets for ${TREATS[treats]} in ${stateName}` : `Vets in ${stateName}`;
      const empty = treats && inState.length
        ? `<p>No vet here lists ${esc(TREATS[treats])} yet. <a href="${base}">See all vets in ${esc(stateName)}</a>.</p>`
        : `<p>We don't have a vet listed in ${esc(stateName)} yet.</p>`;
      return sendHtml(res, page({
        title: `${heading} — Xpress Vet`,
        description: `Call or WhatsApp a vet in ${stateName}. No login needed.`,
        body: `<h1>${esc(heading)}</h1><div class="filters">${filter(base, 'All', !treats)}${filter(`${base}?treats=poultry`, 'Poultry', treats === 'poultry')}${filter(`${base}?treats=pets`, 'Pets', treats === 'pets')}</div>${vets.length ? vets.map(vetCard).join('') : empty}`,
      }));
    } catch (err) {
      return sendError(res, err);
    }
  }

  return { vetPage, statesIndex, statePage };
}

function defaultFindVets(ids) {
  return Professional.find({ _id: { $in: ids } })
    .select('role businessName specialization phone isVerified acceptingClients userId')
    .populate('userId', 'phone')
    .lean();
}
