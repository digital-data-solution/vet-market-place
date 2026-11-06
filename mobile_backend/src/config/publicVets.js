// Vets shown on the public, no-login pages (/v/:id and /vets/:state).
//
// Add a vet ONLY after they have said YES to their phone number appearing on
// an open web page. Listing on the marketplace is not that consent.
//
// `state` and `town` are written by hand because Professional.address is free
// text: it often omits the state and can hold a street address, which these
// pages must not show.
//
// Example: { id: '<professional _id>', state: 'Lagos', town: 'Egbeda' }
export const PUBLIC_VETS = [];

// 36 states + FCT, so a slug that is real but has no vets yet gets a helpful
// page rather than a 404.
export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo',
  'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
  'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba',
  'Yobe', 'Zamfara',
];
