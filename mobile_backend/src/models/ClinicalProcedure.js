import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// CLINICAL PROCEDURE — a flexible, catch-all clinical event so a clinic can
// record ANYTHING it does that isn't already a treatment/vaccination/surgery/
// grooming/hospitalization: imaging (X-ray, ultrasound, CT, MRI, endoscopy),
// dental, deworming, microchipping, euthanasia, physiotherapy, teleconsult,
// emergency, farm visits, reproduction work, and more. `category` is broad and
// free-text-friendly — the clinic picks what fits, or types their own.
// Multi-tenant isolated by `vet`; attributed to the acting staff member.
// Supports an optional result image (e.g. an X-ray photo), like lab results.
// ─────────────────────────────────────────────────────────────────────────────
const procedureSchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client',  required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

  category:    { type: String, required: true, trim: true, maxlength: 60 }, // e.g. "X-ray / Radiology", "Dental", "Deworming", "Other"
  title:       { type: String, trim: true, maxlength: 200 }, // free label, e.g. "Left forelimb X-ray"
  date:        { type: Date, default: Date.now, index: true },
  performedBy: { type: String, trim: true, maxlength: 120 },
  findings:    { type: String, trim: true, maxlength: 2000 }, // results / interpretation
  notes:       { type: String, trim: true, maxlength: 2000 },
  resultImageUrl: { type: String, trim: true, default: null }, // optional attachment (X-ray, scan photo)
  cost:        { type: Number, min: 0, default: null },
  followUpDate:{ type: Date, default: null },

  createdByName: { type: String, trim: true, maxlength: 120, default: null },
}, { timestamps: true });

procedureSchema.index({ vet: 1, date: -1 });
procedureSchema.index({ vet: 1, patient: 1, date: -1 });

export default mongoose.model('ClinicalProcedure', procedureSchema);
