import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// SURGERY RECORD — one surgical procedure performed on a patient. Multi-tenant
// isolated by `vet` (the clinic owner). Attributed to the surgeon / staff member.
// ─────────────────────────────────────────────────────────────────────────────
const surgerySchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client',  required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

  procedure:    { type: String, required: true, trim: true, maxlength: 200 }, // e.g. "Spay (OVH)"
  date:         { type: Date, default: Date.now, index: true },
  surgeon:      { type: String, trim: true, maxlength: 120 },
  anaesthesia:  { type: String, trim: true, maxlength: 200 }, // agent/protocol
  durationMins: { type: Number, min: 0 },
  findings:     { type: String, trim: true, maxlength: 1500 },
  outcome:      { type: String, enum: ['successful', 'complication', 'deceased', 'other'], default: 'successful' },
  notes:        { type: String, trim: true, maxlength: 1500 },
  followUpDate: { type: Date, default: null },
  cost:         { type: Number, min: 0, default: null },

  createdByName: { type: String, trim: true, maxlength: 120, default: null },
}, { timestamps: true });

surgerySchema.index({ vet: 1, date: -1 });
surgerySchema.index({ vet: 1, patient: 1, date: -1 });

export default mongoose.model('SurgeryRecord', surgerySchema);
