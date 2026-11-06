import express from 'express';
import request from 'supertest';
import realApp from '../src/app.js';
import {
  createPublicVetHandlers,
  internationalPhone,
  treatsFrom,
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

function makeApp(publicVets) {
  const app = express();
  const h = createPublicVetHandlers({
    publicVets,
    findVets: async (ids) => docs.filter((d) => ids.includes(d._id)),
  });
  app.get('/v/:id', h.vetPage);
  app.get('/vets', h.statesIndex);
  app.get('/vets/:state', h.statePage);
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

describe('routing in the real app', () => {
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
