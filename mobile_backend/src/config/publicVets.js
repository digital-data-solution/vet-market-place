// Vets shown on the public, no-login pages (/v/:id and /vets/:state).
//
// Until 2026-11-17 a vet was added only after saying YES. On 2026-11-17 Sam
// decided (confirmed in chat) to add listed vets from their marketplace
// listing and tell them afterwards that they can reply NO. Remove any vet who
// says NO the same day.
//
// `state` and `town` are written by hand because Professional.address is free
// text: it often omits the state and can hold a street address, which these
// pages must not show.
//
// `treats` is optional ('poultry', 'pets', 'farm'). Use it when the vet told us
// what they treat and their listing doesn't say; otherwise it comes from the
// listing's specialization.
//
// `noWhatsApp: true` hides the WhatsApp button when the number isn't on WhatsApp.
//
// Example: { id: '<professional _id>', state: 'Lagos', town: 'Egbeda' }
export const PUBLIC_VETS = [
  // Pawpriority: said Yes on WhatsApp, 2026-11-06 17:23; town and listing number confirmed 17:26.
  { id: '6a79d7dcb1fc0044a3ee670a', state: 'Lagos', town: 'Surulere', treats: ['poultry', 'pets'] },
  // Nayah's: said YES on WhatsApp, 2026-11-06 20:53; town and listing number confirmed 20:54.
  { id: '6a7ebe972c5e56fc5b9ba8c4', state: 'Kwara', town: 'Ilorin' },
  // BST: said Yes on WhatsApp, 2026-11-06 20:53; town and listing number confirmed 20:56. Does not treat poultry.
  { id: '6a81dbb543c70eb7db372e0a', state: 'Oyo', town: 'Ologuneru, Ibadan', treats: ['pets', 'farm'] },
  // Allismic: said Yes on WhatsApp, 2026-11-06 18:24. Sam confirmed the town and listing number.
  { id: '6a95e7310533e9acb7893cce', state: 'Oyo', town: 'Ojoo, Ibadan' },
  // Veterinary Clinic Kwoi: said Yes on WhatsApp, 2026-11-06 22:20; accepting clients 22:21; said Kaduna State earlier.
  { id: '6a30fb862d7049bee5988ad2', state: 'Kaduna', town: 'Kwoi' },
  // Petsure: said Yes on WhatsApp to the public-page question, 2026-11-07 05:05. Town from listing (Enugu); also covers Ebonyi.
  { id: '6a9c84c07b818adec40bd631', state: 'Enugu', town: 'Enugu (also covers Ebonyi)' },

  // Added 2026-11-17 on Sam's decision, from their listings (town only, never the street).
  // dev-fa tells each vet afterwards; anyone who replies NO comes off.
  // Livestock Crib told us on 11-06 they treat poultry, dogs and cats.
  { id: '6a2fd3de84d2f7edb841fc8d', state: 'Lagos', town: 'Alapere', treats: ['poultry', 'pets', 'farm'] },
  { id: '6a7ca3b42c5e56fc5b9ba88c', state: 'Lagos', town: 'Egbeda' },
  // Newlife and Exquisite Pets: number not on WhatsApp (dev-fa, 11-17), so Call only.
  { id: '6a96aa560533e9acb7893d59', state: 'Lagos', town: 'Festac', noWhatsApp: true },
  { id: '6a336327e63dcfdb9da35a7f', state: 'Oyo', town: 'Odo Ona, Ibadan' },
  { id: '6a82f14a0de4698741204319', state: 'Oyo', town: 'Bodija, Ibadan', noWhatsApp: true },
  { id: '6a7b35519f5cf7e6c8f82e5b', state: 'Ogun', town: 'Obafemi Owode' },
  { id: '6a32b92a797aab86cb335ef7', state: 'Ogun', town: 'Magboro (also visits Lagos and along the Lagos–Ibadan Expressway)' },
  { id: '6a44110fd5d887b90d5082f8', state: 'Kaduna', town: 'Zaria' },
  // Amriza Poultry Farm REMOVED 2026-11-17 20:23: "Ours is a Farm ... Egg Production solely", not a vet service.
  { id: '6a7b14859f5cf7e6c8f82e3f', state: 'FCT', town: 'Abuja Municipal (AMAC)' },
  { id: '6a340a3194e929b554229473', state: 'Osun', town: 'Okuku' },
  { id: '6a9904fc92fa168870dfd205', state: 'Delta', town: 'Asaba' },
];

// 36 states + FCT, so a slug that is real but has no vets yet gets a helpful
// page rather than a 404.
export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo',
  'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
  'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba',
  'Yobe', 'Zamfara',
];
