import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// GROOMING RECORD — one grooming service for a patient (bath, full groom, nail
// trim, de-shed...). Multi-tenant isolated by `vet` (the clinic/shop owner).
// Attributed to the groomer / staff member.
// ─────────────────────────────────────────────────────────────────────────────
const groomingSchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client',  required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

  service:     { type: String, required: true, trim: true, maxlength: 200 }, // e.g. "Full groom + nails"
  date:        { type: Date, default: Date.now, index: true },
  groomer:     { type: String, trim: true, maxlength: 120 },
  products:    { type: String, trim: true, maxlength: 300 }, // shampoo/products used
  notes:       { type: String, trim: true, maxlength: 1000 },
  price:       { type: Number, min: 0, default: null },
  nextDueDate: { type: Date, default: null }, // for a "next groom" reminder later

  createdByName: { type: String, trim: true, maxlength: 120, default: null },
}, { timestamps: true });

groomingSchema.index({ vet: 1, date: -1 });
groomingSchema.index({ vet: 1, patient: 1, date: -1 });

export default mongoose.model('GroomingRecord', groomingSchema);
