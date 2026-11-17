import express from 'express';
import request from 'supertest';
import realApp from '../src/app.js';
import {
  createPublicVetHandlers,
  internationalPhone,
  treatsFrom,
  visitSource,
} from '../src/api/publicVets.controller.js';

const YES = 'a'.repeat(24);
const STOPPED = 'b'.repeat(24);
const NOT_LISTED = 'c'.repeat(24);

const docs = [
  {
    _id: YES,
    role: 'vet',
    name: 'Dr Private Name',
    vcnNumber: 'VCN-SECRET',
    email: 'private@example.com',
    address: '5 Hidden Street, Egbeda, Lagos',
    businessName: 'Test Vet Clinic',
    specialization: 'Livestock &amp; Farm Animals, Poultry',
    phone: '0803 123 4567',
    isVerified: true,
    acceptingClients: true,
  },
  {
    _id: STOPPED,
    role: 'vet',
    businessName: 'Closed Clinic',
    specialization: 'Poultry',
    phone: '08031234568',
    isVerified: true,
    acceptingClients: false,
  },
];

function makeApp(publicVets, events = []) {
  const app = express();
  app.use(express.json());
  const h = createPublicVetHandlers({
    publicVets,
    findVets: async (ids) => docs.filter((d) => ids.includes(d._id)),
    recordEvent: async (e) => { events.push(e); },
  });
  app.post('/api/public/tap', h.tap);
  app.get('/v/:id', h.vetPage);
  app.get('/vets', h.statesIndex);
  app.get('/vets/:state', h.statePage);
  app.get('/poultry-vets/:state', (req, res) => { req.params.type = 'poultry-vets'; return h.guidePage(req, res); });
  app.get('/pet-vets/:state', (req, res) => { req.params.type = 'pet-vets'; return h.guidePage(req, res); });
  return app;
}

const list = [
  { id: YES, state: 'Lagos', town: 'Egbeda' },
  { id: STOPPED, state: 'Lagos', town: 'Ikeja' },
];

describe('public vet pages', () => {
  test('shows contact buttons without a login', async () => {
    const res = await request(makeApp(list)).get(`/v/${YES}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('tel:+2348031234567');
    expect(res.text).toContain('https://wa.me/2348031234567');
    expect(res.text).toContain('Livestock and farm animals');
  });

  test('never shows personal name, VCN, email or street address', async () => {
    const res = await request(makeApp(list)).get(`/v/${YES}`);
    for (const secret of ['Dr Private Name', 'VCN-SECRET', 'private@example.com', 'Hidden Street']) {
      expect(res.text).not.toContain(secret);
    }
  });

  test('a vet not on the consent list goes to the normal profile', async () => {
    const res = await request(makeApp(list)).get(`/v/${NOT_LISTED}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`/VetProfile?vetId=${NOT_LISTED}`);
  });

  test('a vet not accepting clients is hidden even with consent', async () => {
    const res = await request(makeApp(list)).get(`/v/${STOPPED}`);
    expect(res.status).toBe(302);
    const state = await request(makeApp(list)).get('/vets/lagos');
    expect(state.text).not.toContain('Closed Clinic');
  });

  test('a state page filters by what the vet treats', async () => {
    const app = makeApp(list);
    const poultry = await request(app).get('/vets/lagos?treats=poultry');
    expect(poultry.text).toContain('Test Vet Clinic');
    const pets = await request(app).get('/vets/lagos?treats=pets');
    expect(pets.text).not.toContain('Test Vet Clinic');
    expect(pets.text).toContain('No vet here lists');
  });

  test('what a vet told us they treat overrides their listing', async () => {
    const app = makeApp([{ id: YES, state: 'Lagos', town: 'Egbeda', treats: ['pets'] }]);
    const pets = await request(app).get('/vets/lagos?treats=pets');
    expect(pets.text).toContain('Test Vet Clinic');
    const poultry = await request(app).get('/vets/lagos?treats=poultry');
    expect(poultry.text).not.toContain('Test Vet Clinic');
  });

  test('a real state with no vets says so, and an unknown state goes to the index', async () => {
    const app = makeApp(list);
    const empty = await request(app).get('/vets/cross-river');
    expect(empty.status).toBe(200);
    expect(empty.text).toContain('listed in Cross River yet');
    const unknown = await request(app).get('/vets/atlantis');
    expect(unknown.status).toBe(302);
    expect(unknown.headers.location).toBe('/vets');
  });

  test('an empty consent list shows no vets and no phone numbers', async () => {
    const app = makeApp([]);
    const index = await request(app).get('/vets');
    expect(index.text).toContain('No vets are listed here yet');
    expect((await request(app).get(`/v/${YES}`)).status).toBe(302);
  });
});

describe('Google guide pages', () => {
  test('a guide page can be indexed and lists the vet without a phone number', async () => {
    const res = await request(makeApp(list)).get('/poultry-vets/lagos');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('noindex');
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.text).toContain('rel="canonical" href="https://go.xpressvetmarketplace.com/poultry-vets/lagos"');
    expect(res.text).toContain('Test Vet Clinic');
    expect(res.text).toContain(`href="/v/${YES}"`);
    expect(res.text).not.toContain('2348031234567');
    expect(res.text).not.toContain('Closed Clinic');
    for (const secret of ['Dr Private Name', 'VCN-SECRET', 'private@example.com', 'Hidden Street']) {
      expect(res.text).not.toContain(secret);
    }
  });

  test('a guide only lists vets who treat that kind of animal', async () => {
    const res = await request(makeApp(list)).get('/pet-vets/lagos');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Test Vet Clinic');
    expect(res.text).toContain('is listed in Lagos yet');
  });

  test('a state without a guide goes to its normal page', async () => {
    const app = makeApp(list);
    const noGuide = await request(app).get('/poultry-vets/cross-river');
    expect(noGuide.status).toBe(302);
    expect(noGuide.headers.location).toBe('/vets/cross-river');
    const unknown = await request(app).get('/pet-vets/atlantis');
    expect(unknown.headers.location).toBe('/vets');
  });

  test('the WhatsApp pages stay out of Google', async () => {
    const res = await request(makeApp(list)).get('/vets/lagos');
    expect(res.text).toContain('noindex');
  });
});

describe('topic guides', () => {
  const makeTopicApp = (events = []) => {
    const app = express();
    const h = createPublicVetHandlers({ publicVets: list, findVets: async () => docs, recordEvent: async (e) => { events.push(e); } });
    app.get('/guides', h.topicsIndex);
    app.get('/guides/:slug', h.topicPage);
    return app;
  };

  test('a topic page can be indexed and links to vets, the pack and related topics', async () => {
    const events = [];
    const res = await request(makeTopicApp(events)).get('/guides/newcastle-disease-in-chickens').set('Referer', 'https://www.google.com/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('noindex');
    expect(res.text).toContain('rel="canonical" href="https://go.xpressvetmarketplace.com/guides/newcastle-disease-in-chickens"');
    expect(res.text).toContain('href="/poultry-vets/lagos"');
    expect(res.text).toContain('selar.com/5779aps353');
    expect(res.text).toContain('href="/guides/coccidiosis-in-chickens"');
    expect(res.text).toContain('does not replace an examination by a vet');
    expect(events).toContainEqual({ kind: 'view', path: '/guides/newcastle-disease-in-chickens', src: 'google' });
  });

  test('a pet topic points to pet vets and the Dog pack, not poultry', async () => {
    const res = await request(makeTopicApp()).get('/guides/parvo-in-puppies');
    expect(res.text).toContain('href="/pet-vets/lagos"');
    expect(res.text).toContain('selar.com/2900z16541');
    expect(res.text).not.toContain('5779aps353');
    expect(res.text).not.toContain('/poultry-vets/');
  });

  test('the index lists every topic, and an unknown topic goes to the index', async () => {
    const app = makeTopicApp();
    const index = await request(app).get('/guides');
    for (const slug of ['newcastle-disease-in-chickens', 'coccidiosis-in-chickens', 'gumboro-disease-in-chickens', 'parvo-in-puppies']) {
      expect(index.text).toContain(`href="/guides/${slug}"`);
    }
    const unknown = await request(app).get('/guides/bird-flu-cure');
    expect(unknown.status).toBe(302);
    expect(unknown.headers.location).toBe('/guides');
  });
});

describe('counting visits and taps', () => {
  test('a Google visit to a guide is counted, and the source follows the farmer to the vet page', async () => {
    const events = [];
    const app = makeApp(list, events);
    const guide = await request(app).get('/poultry-vets/lagos').set('Referer', 'https://www.google.com.ng/');
    expect(events).toContainEqual({ kind: 'view', path: '/poultry-vets/lagos', src: 'google' });
    expect(guide.text).toContain(`href="/v/${YES}?from=google"`);
    const vet = await request(app).get(`/v/${YES}?from=google`);
    expect(events).toContainEqual({ kind: 'view', path: `/v/${YES}`, vetId: YES, src: 'google' });
    expect(vet.text).toContain('data-tap="whatsapp"');
    expect(vet.text).toContain('data-src="google"');
    expect(vet.text).toContain("sendBeacon('/api/public/tap'");
  });

  test('a tap on a listed vet is counted; anything else is ignored', async () => {
    const events = [];
    const app = makeApp(list, events);
    const ok = await request(app).post('/api/public/tap').send({ vet: YES, kind: 'whatsapp', src: 'google', path: `/v/${YES}` });
    expect(ok.status).toBe(204);
    expect(events).toEqual([{ kind: 'whatsapp', vetId: YES, src: 'google', path: `/v/${YES}` }]);
    await request(app).post('/api/public/tap').send({ vet: NOT_LISTED, kind: 'call' });
    await request(app).post('/api/public/tap').send({ vet: YES, kind: 'delete' });
    await request(app).post('/api/public/tap').send({ vet: YES, kind: 'call', src: '<script>' });
    expect(events).toHaveLength(2);
    expect(events[1].src).toBe('direct');
  });

  test('link-preview crawlers are not counted', async () => {
    const events = [];
    await request(makeApp(list, events)).get('/poultry-vets/lagos').set('User-Agent', 'WhatsApp/2.23');
    await request(makeApp(list, events)).get('/poultry-vets/lagos').set('User-Agent', 'Googlebot/2.1');
    expect(events).toHaveLength(0);
  });

  test('visitSource', () => {
    const req = (query, referer) => ({ query, get: (h) => (h === 'referer' ? referer : '') });
    expect(visitSource(req({ src: 'ig' }))).toBe('ig');
    expect(visitSource(req({ from: 'google' }, 'https://go.xpressvetmarketplace.com/x'))).toBe('google');
    expect(visitSource(req({}, 'https://www.google.com/'))).toBe('google');
    expect(visitSource(req({}, 'https://m.facebook.com/'))).toBe('fb');
    expect(visitSource(req({}, 'https://l.instagram.com/'))).toBe('ig');
    expect(visitSource(req({}, ''))).toBe('direct');
    expect(visitSource(req({ src: 'BAD TAG!' }, 'https://example.org/'))).toBe('other');
  });
});

describe('routing in the real app', () => {
  test('the Google Search Console ownership file is served', async () => {
    const res = await request(realApp).get('/google418686a976f055c5.html');
    expect(res.status).toBe(200);
    expect(res.text).toBe('google-site-verification: google418686a976f055c5.html');
  });

  test('robots.txt and sitemap.xml list the guide pages', async () => {
    const robots = await request(realApp).get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.text).toContain('Sitemap: https://go.xpressvetmarketplace.com/sitemap.xml');
    const map = await request(realApp).get('/sitemap.xml');
    expect(map.headers['content-type']).toContain('xml');
    for (const p of ['/poultry-vets/lagos', '/pet-vets/oyo', '/poultry-vets/kwara', '/guides', '/guides/parvo-in-puppies']) {
      expect(map.text).toContain(`https://go.xpressvetmarketplace.com${p}`);
    }
  });


  test('the SPA catch-all does not swallow the public pages', async () => {
    // A state with no consenting vets, so this needs no database.
    const state = await request(realApp).get('/vets/cross-river');
    expect(state.status).toBe(200);
    expect(state.text).toContain('Vets in Cross River');
  });
});

describe('helpers', () => {
  test('internationalPhone', () => {
    expect(internationalPhone('0803 123 4567')).toBe('2348031234567');
    expect(internationalPhone('+234 803 123 4567')).toBe('2348031234567');
    expect(internationalPhone('12345')).toBeNull();
    expect(internationalPhone(undefined)).toBeNull();
  });

  test('treatsFrom reads self-declared species', () => {
    expect(treatsFrom('Small Animals, Poultry')).toEqual(['poultry', 'pets']);
    expect(treatsFrom('Livestock &amp; Farm Animals')).toEqual(['farm']);
    expect(treatsFrom('General Practice')).toEqual([]);
    expect(treatsFrom(undefined)).toEqual([]);
  });
});
