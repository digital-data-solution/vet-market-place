import mongoose from 'mongoose';

// A vet's client (pet owner) — not necessarily an Xpress Vet app user.
// If they *are* a platform user, linkedUserId ties the record to them so
// reminders can reach them via push, not just the vet's own email digest.
const clientSchema = new mongoose.Schema({
  vet: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name:  { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  address: { type: String, trim: true, maxlength: 300 },

  // Set if this client also has an Xpress Vet account (matched by phone/email
  // at creation time, or linked manually) — enables owner-facing reminders.
  linkedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Opt-IN, defaults false: Xpress Vet never emails a client unless the vet
  // explicitly turns this on for them. The vet has the real relationship
  // and the client's actual consent (or doesn't) — we don't impose it.
  emailRemindersEnabled: { type: Boolean, default: false },

  // Separate safety valve: if the client themselves clicks "stop these
  // emails" in a reminder, this wins even if the vet re-enables the toggle
  // above later. Distinct from User.marketingOptOut — opting out of "reminders
  // about my pet from my vet" is not the same consent as Xpress Vet's own marketing.
  reminderOptOut: { type: Boolean, default: false },

  notes: { type: String, trim: true, maxlength: 1000 },

  createdByName: { type: String, trim: true, maxlength: 120, default: null }, // who registered them (hospital-flow attribution)
}, { timestamps: true });

clientSchema.index({ vet: 1, name: 'text', phone: 'text', email: 'text' });

export default mongoose.model('Client', clientSchema);
