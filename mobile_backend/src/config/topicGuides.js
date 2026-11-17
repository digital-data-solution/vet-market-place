// Google-searchable health topic pages: /guides/:slug (index at /guides).
//
// Each page answers one question farmers or pet owners search for, honestly
// and in plain English, then points to a vet (our state pages) and to the
// matching Academy pack. General information only: no drug doses, no brand
// names, and always "see a vet" for diagnosis and treatment.
//
// `animal` is 'poultry' or 'pets' and picks the vet pages, pack and forum link.
// Sections: { h: heading, p: [paragraphs], ul: [list items] } (p and ul optional).

export const TOPICS = {
  'newcastle-disease-in-chickens': {
    animal: 'poultry',
    title: 'Newcastle disease in chickens: signs, what to do and how to prevent it',
    short: 'Newcastle disease',
    description: 'Twisted necks, green droppings and sudden deaths? Learn the signs of Newcastle disease in chickens, what to do today, and how vaccination and biosecurity prevent it.',
    lead: 'Newcastle disease is one of the most feared poultry diseases in Nigeria. It spreads fast, can kill most of a flock within days, and has no cure. The good news: vaccination and simple farm hygiene prevent it.',
    sections: [
      { h: 'Signs to look for', ul: [
        'Sudden deaths, sometimes many birds in one or two days',
        'Gasping, coughing, sneezing and rattling breathing',
        'Greenish, watery droppings',
        'Twisted neck, circling, falling over or paralysed legs or wings',
        'Swelling around the eyes and head',
        'A sharp drop in eggs; thin-shelled, soft or misshapen eggs',
      ] },
      { h: 'What causes it', p: [
        'A virus. It spreads through sick birds, their droppings, and anything that carries them: people’s shoes and clothes, crates, egg trays, feed bags, vehicles and wild birds. New birds from a market are a common source.',
      ] },
      { h: 'What to do today', ul: [
        'Call a vet now. Other diseases (such as fowl cholera, bird flu or Gumboro) can look similar, and the right action depends on the diagnosis.',
        'Take fresh dead birds to the vet for a post-mortem. It is the fastest way to confirm what is killing your birds.',
        'Separate sick birds and stop visitors, sales and bird movements until you know what it is.',
        'Do not rely on antibiotics. They do not kill the virus; a vet may use them only for infections that follow it.',
        'Bury or burn dead birds. Never throw them where dogs, wild birds or neighbours’ chickens can reach them.',
      ] },
      { h: 'How to prevent it', ul: [
        'Vaccinate on time. Your vet will set a schedule for your birds, usually starting in the first week of life with boosters after.',
        'Handle vaccines well: keep them cold, use them within the time on the label after mixing, and never mix them with chlorinated water.',
        'Biosecurity: footbath at the pen door, few visitors, clean crates and trays, and don’t mix new birds with your flock.',
        'Keep records of vaccination dates and batch numbers so you can check what went wrong if birds still fall sick.',
      ] },
    ],
    related: ['gumboro-disease-in-chickens', 'coccidiosis-in-chickens'],
  },

  'coccidiosis-in-chickens': {
    animal: 'poultry',
    title: 'Coccidiosis in chickens: bloody droppings, causes, treatment and prevention',
    short: 'Coccidiosis',
    description: 'Bloody or brown watery droppings in your chickens? It may be coccidiosis. Learn the signs, why wet litter causes it, what to do and how to prevent it.',
    lead: 'Coccidiosis is one of the most common causes of sick and dying young birds on Nigerian farms, especially in the rainy season. It is caused by tiny parasites that thrive in wet litter, and it is very treatable when caught early.',
    sections: [
      { h: 'Signs to look for', ul: [
        'Bloody, brown or watery droppings',
        'Birds that stand hunched with ruffled feathers and half-closed eyes',
        'Pale combs and wattles',
        'Eating and drinking less, poor growth and uneven size in the flock',
        'Deaths, most often in birds about 3 to 6 weeks old',
      ] },
      { h: 'What causes it', p: [
        'Coccidia parasites. Birds swallow their eggs from droppings in the litter. Warm, wet litter lets the eggs develop fast, which is why outbreaks follow leaking drinkers, rain getting into the pen and overcrowding.',
      ] },
      { h: 'What to do today', ul: [
        'Call a vet. Bloody droppings can have other causes, and the vet will choose the right anticoccidial drug and treatment length.',
        'Remove wet and caked litter and replace it with dry litter. Fix leaking drinkers.',
        'Give treatment through the drinking water exactly as the vet says, for the full number of days, even after birds look better.',
        'Keep the withdrawal period before selling birds or eggs.',
      ] },
      { h: 'How to prevent it', ul: [
        'Keep litter dry: good ventilation, no leaking drinkers, and turn or top up litter often.',
        'Don’t overcrowd.',
        'Ask your vet about anticoccidials in feed or a coccidiosis vaccine for your type of birds.',
        'Clean and dry the house well between batches.',
      ] },
    ],
    related: ['newcastle-disease-in-chickens', 'gumboro-disease-in-chickens'],
  },

  'gumboro-disease-in-chickens': {
    animal: 'poultry',
    title: 'Gumboro disease (IBD) in chickens: signs, what to do and vaccination',
    short: 'Gumboro disease (IBD)',
    description: 'Sudden sickness and deaths in 3–6 week old birds with whitish diarrhoea? It may be Gumboro (IBD). Learn the signs, what to do and why vaccine timing matters.',
    lead: 'Gumboro disease, also called infectious bursal disease (IBD), mostly hits young birds around 3 to 6 weeks old. Even birds that survive are left with a weak immune system, so they catch other diseases easily and respond poorly to vaccines.',
    sections: [
      { h: 'Signs to look for', ul: [
        'Sudden illness in many young birds at once',
        'Dullness, ruffled feathers and birds sitting or sleeping a lot',
        'Whitish, watery droppings; dirty vent feathers',
        'Birds pecking at their own vent',
        'Deaths that rise quickly for a few days, then fall',
      ] },
      { h: 'What causes it', p: [
        'A very tough virus that survives for months in poultry houses and litter. It damages the bursa, an organ young birds need to build immunity.',
      ] },
      { h: 'What to do today', ul: [
        'Call a vet and take fresh dead birds for a post-mortem. A swollen or bloody bursa points to Gumboro.',
        'There is no cure. Supportive care helps more birds survive: clean water, electrolytes and vitamins as the vet advises, warmth, and easy access to feed and water.',
        'Watch the flock closely in the weeks after. Weak immunity means other diseases may follow.',
      ] },
      { h: 'How to prevent it', ul: [
        'Vaccinate at the right time. Antibodies passed from the hen protect chicks at first but also block the vaccine, so timing matters. Ask your vet for a schedule.',
        'Buy chicks from a reliable hatchery with good breeder vaccination.',
        'Clean and disinfect the house thoroughly between batches and leave it empty for a while before new chicks.',
      ] },
    ],
    related: ['newcastle-disease-in-chickens', 'coccidiosis-in-chickens'],
  },

  'parvo-in-puppies': {
    animal: 'pets',
    title: 'Parvo in puppies: signs, what to do now and how to prevent it',
    short: 'Parvo in puppies',
    description: 'Is your puppy vomiting with smelly or bloody diarrhoea? It could be parvo. Learn the signs, why it is an emergency, and how vaccines prevent it.',
    lead: 'Canine parvovirus kills many puppies in Nigeria every year. It attacks the gut and immune system, and a puppy can go from playful to very sick in a day. With fast treatment from a vet, many puppies survive.',
    sections: [
      { h: 'Signs to look for', ul: [
        'Vomiting, often many times',
        'Diarrhoea that smells very bad, often with blood',
        'Weakness, sleeping a lot, not wanting to play',
        'Not eating or drinking',
        'Signs of dehydration: sunken eyes, dry gums, skin that stays up when pinched',
        'Most common in puppies from about 6 weeks to 6 months that are not fully vaccinated',
      ] },
      { h: 'What to do now', ul: [
        'Treat it as an emergency: call or WhatsApp a vet today. Puppies can die within a day or two from dehydration.',
        'Don’t force food or give human medicines.',
        'Keep the puppy away from other dogs, especially young ones.',
        'Clean the area with diluted household bleach (the vet can tell you the strength). Parvo survives for months and many common disinfectants don’t kill it.',
      ] },
      { h: 'How to prevent it', ul: [
        'Vaccinate: puppies start their core vaccines at about 6–8 weeks, with boosters every few weeks until about 16 weeks, then as your vet advises.',
        'Until the vaccine course is done, keep your puppy away from unknown dogs and places where many dogs pass.',
        'Deworm and feed well; a healthy puppy copes better if it does get sick.',
        'If you breed, vaccinate the mother before mating.',
      ] },
    ],
    related: [],
  },
};

export const TOPIC_ANIMALS = {
  poultry: {
    guideType: 'poultry-vets',
    findVet: 'Find a poultry vet near you (call or WhatsApp, no login):',
    learn: {
      text: 'Learn to spot and prevent diseases like this before they cost you birds. The Poultry Farm Health Pack from Xpress Digital Academy has 25 short courses and 93 videos for farmers.',
      href: 'https://selar.com/5779aps353',
      button: 'See the Poultry Farm Health Pack',
    },
    community: {
      text: 'Have a question about your birds? Ask in the free Xpress Vet Poultry Farmers Forum on WhatsApp.',
      href: 'https://chat.whatsapp.com/DGlig3opDGKDpVTlPHzIFQ',
      button: 'Join the forum',
    },
  },
  pets: {
    guideType: 'pet-vets',
    findVet: 'Find a vet for dogs and cats near you (call or WhatsApp, no login):',
    learn: {
      text: 'Raising or breeding dogs? The Dog Health & Breeding Pack from Xpress Digital Academy has 19 courses with lessons and quizzes, including canine parvovirus, puppy vaccination schedules and breeding.',
      href: 'https://selar.com/2900z16541',
      button: 'See the Dog Health & Breeding Pack',
    },
  },
};
