import mongoose from 'mongoose';

// An animal under a vet's care — the core record the rest of the practice
// module (treatments, vaccinations, reminders) hangs off of. Free-tier
// patient count is enforced in practice.controller.js, not here.
const patientSchema = new mongoose.Schema({
  vet:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },

  name:    { type: String, required: true, trim: true, maxlength: 100 },
  species: { type: String, trim: true, maxlength: 60 }, // free text: dog, cat, rabbit, bird...
  breed:   { type: String, trim: true, maxlength: 100 },
  sex:     { type: String, enum: ['male', 'female', 'unknown'], default: 'unknown' },
  dob:     { type: Date },
  weightKg:    { type: Number, min: 0 },
  color:       { type: String, trim: true, maxlength: 100 },
  microchipId: { type: String, trim: true, maxlength: 60 },
  photo:       { type: String, trim: true }, // Cloudinary URL, uploaded via existing /api/upload

  notes: { type: String, trim: true, maxlength: 1000 },

  // Soft-delete flag so a vet can archive a patient without losing history,
  // and so archived patients don't count against the free-tier limit.
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

patientSchema.index({ vet: 1, isActive: 1 });
patientSchema.index({ vet: 1, name: 'text' });

export default mongoose.model('Patient', patientSchema);
