// Google-searchable guide pages: /poultry-vets/:state and /pet-vets/:state.
//
// Unlike /vets/:state (shared on WhatsApp, noindex), these pages are meant to
// be found on Google. They never print a vet's phone number: each vet card
// links to the noindex /v/:id page, which holds the Call/WhatsApp buttons.
//
// Add a state here only when at least one vet there is on the public list
// (config/publicVets.js). Each state gets its own intro so the pages are not
// copies of each other.

export const GUIDE_TYPES = {
  'poultry-vets': {
    treats: 'poultry',
    noun: 'poultry vet',
    title: (s) => `Poultry vet in ${s} — call or WhatsApp, no login`,
    h1: (s) => `Poultry vets in ${s} State`,
    description: (s) => `Find a vet for your broilers, layers and other birds in ${s}. Call or WhatsApp directly, no login. Plus a simple health checklist for poultry farmers.`,
    tipsHeading: 'Poultry health checklist',
    tips: [
      ['Brooding', 'Day-old chicks need about 32–35°C in the first week, then a little less each week. Watch them: chicks crowding under the heat are cold; chicks panting with wings spread are too hot.'],
      ['Vaccination', 'Newcastle disease and Gumboro (IBD) vaccines are given in the first weeks of life. Ask a vet for a schedule that fits your birds and area, keep vaccines cold, use them soon after mixing, and never mix them with chlorinated water.'],
      ['Warning signs', 'Call a vet early if you see sudden deaths, greenish or bloody droppings, twisted necks, birds that stop eating or drinking, or a sudden drop in eggs.'],
      ['Post-mortem', 'When birds die, take fresh carcasses to a vet for a post-mortem. It is the fastest way to know what is killing your birds and what treatment will actually work.'],
      ['Drugs', 'Don’t give antibiotics without a diagnosis. Wrong drugs waste money and cause resistance. Always keep the withdrawal period before you sell birds or eggs.'],
      ['Biosecurity', 'Footbath at the pen door, few visitors, no new birds mixed with old ones, and clean, dry litter. Wet litter in the rainy season brings coccidiosis.'],
      ['Weather', 'Harmattan (November–February) brings dust and cold nights, so watch for coughing and sneezing. March–April heat brings heat stress: give cool water and good airflow.'],
    ],
    faq: [
      ['Do I need to sign up to contact a vet?', 'No. Open a vet below and tap Call or WhatsApp. No login, no fee to Xpress Vet.'],
      ['How much does a farm visit cost?', 'Each vet sets their own fee. Agree the service and the price with the vet before the visit.'],
      ['Can a vet help me without a visit?', 'Many vets can advise on WhatsApp from clear photos or a video of sick or dead birds. Some cases still need a visit or a post-mortem.'],
    ],
    learn: {
      text: 'Want to spot disease early and cut losses? The Poultry Farm Health Pack from Xpress Digital Academy has 25 short courses and 93 videos for farmers.',
      href: 'https://selar.com/5779aps353',
      button: 'See the Poultry Farm Health Pack',
    },
    community: {
      text: 'Join the free Xpress Vet Poultry Farmers Forum on WhatsApp to ask questions and learn from other farmers.',
      href: 'https://chat.whatsapp.com/DGlig3opDGKDpVTlPHzIFQ',
      button: 'Join the forum',
    },
  },
  'pet-vets': {
    treats: 'pets',
    noun: 'vet for dogs and cats',
    title: (s) => `Vet for dogs and cats in ${s} — call or WhatsApp, no login`,
    h1: (s) => `Vets for dogs and cats in ${s} State`,
    description: (s) => `Find a vet for your dog or cat in ${s}. Call or WhatsApp directly, no login. Plus vaccine and health basics for pet owners.`,
    tipsHeading: 'Dog and cat health basics',
    tips: [
      ['Rabies', 'Vaccinate dogs and cats against rabies, then repeat as your vet advises (usually yearly). Rabies kills and spreads to people. After any dog bite, wash the wound with soap and running water for 15 minutes and go to a hospital.'],
      ['Puppy vaccines', 'Puppies start their core vaccines (including parvovirus) at about 6–8 weeks, with boosters every few weeks until about 16 weeks. Keep them away from unknown dogs until the course is done.'],
      ['Parvo is an emergency', 'Vomiting, smelly or bloody diarrhoea and weakness in a puppy can be parvo. Call a vet the same day: delay costs lives.'],
      ['Deworming', 'Deworm puppies and kittens often in the first months, then every few months for life. Ask your vet for the right product and dose for the weight.'],
      ['Ticks', 'Check your dog for ticks every day. Ticks spread blood diseases that cause fever, weakness and pale gums. Use a tick control your vet recommends.'],
      ['Dangerous foods', 'No chocolate, onions, garlic, grapes or cooked bones. Keep rat poison and insecticides out of reach.'],
    ],
    faq: [
      ['Do I need to sign up to contact a vet?', 'No. Open a vet below and tap Call or WhatsApp. No login, no fee to Xpress Vet.'],
      ['Do vets come to the house?', 'Some do. Ask the vet on WhatsApp whether they do home visits in your area and what it costs.'],
      ['When should I see a vet urgently?', 'Breathing trouble, repeated vomiting, bloody diarrhoea, seizures, a swollen belly, poisoning, or a dog or cat that will not eat or stand.'],
    ],
    learn: {
      text: 'Raising or breeding dogs? The Dog Health & Breeding Pack from Xpress Digital Academy has 19 courses with lessons and quizzes.',
      href: 'https://selar.com/2900z16541',
      button: 'See the Dog Health & Breeding Pack',
    },
  },
};

// One unique intro per state and type.
export const GUIDE_STATES = {
  Lagos: {
    'poultry-vets': 'Lagos has thousands of poultry farms, from backyard broilers to large layer houses in Ikorodu, Epe and Badagry. With high feed prices, one disease outbreak can wipe out a batch. Getting a vet early is cheaper than losing birds.',
    'pet-vets': 'Many Lagos homes keep dogs for security and as family pets. Rabies vaccines, puppy shots, tick control and quick help in an emergency all start with a vet you can reach on the phone.',
  },
  Oyo: {
    'poultry-vets': 'Oyo is one of Nigeria’s biggest egg-producing states, with layer and broiler farms around Ibadan, Ogbomoso and Oyo town. Close farms mean disease spreads fast, so early diagnosis matters.',
    'pet-vets': 'From Ibadan to Ogbomoso, dog owners in Oyo need a vet for vaccines, ticks, deworming and emergencies. Below are vets listed for dogs, cats and other pets.',
  },
  Kaduna: {
    'poultry-vets': 'Kaduna has a large and growing poultry sector, from Zaria and Kaduna city down to Southern Kaduna. Hot dry seasons and harmattan dust put birds under stress, so a vet you can reach quickly saves birds and money.',
    'pet-vets': 'From Kaduna city to Zaria and Southern Kaduna, dog and cat owners can reach a vet below for rabies vaccines, puppy shots, deworming and emergencies.',
  },
  Enugu: {
    'poultry-vets': 'Poultry farms are growing across Enugu and neighbouring Ebonyi, from small backyard flocks to commercial broiler and layer houses. In the rainy season, wet litter brings coccidiosis, so act early when droppings change.',
    'pet-vets': 'Dog and cat owners in Enugu and Ebonyi can reach a vet below for vaccines, tick control, deworming and emergencies.',
  },
  Kwara: {
    'poultry-vets': 'Poultry farming is growing fast around Ilorin and across Kwara. Strong harmattan and hot dry months put birds under stress, and stressed birds fall sick more easily.',
    'pet-vets': 'Dog and cat owners in Ilorin and across Kwara can reach a vet below for vaccines, deworming, tick control and emergencies.',
  },
};
