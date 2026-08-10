import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// HOSPITALIZATION — an inpatient stay (a "ward" admission). For clinics that keep
// animals for days: admit → daily care logs → discharge. Multi-tenant isolated by
// `vet` (the clinic owner). Each daily log and the admit/discharge is attributed
// to the staff member who did it (hospital-flow accountability).
// ─────────────────────────────────────────────────────────────────────────────
const dailyLogSchema = new mongoose.Schema(
  {
    at:          { type: Date, default: Date.now },
    note:        { type: String, trim: true, maxlength: 1000 }, // observations / care given
    temperature: { type: Number, min: 0 },      // °C
    weightKg:    { type: Number, min: 0 },
    medication:  { type: String, trim: true, maxlength: 300 },
    feeding:     { type: String, trim: true, maxlength: 300 },
    byName:      { type: String, trim: true, maxlength: 120, default: null }, // who logged it
  },
  { _id: true },
);

const hospitalizationSchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client',  required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

  reason:      { type: String, trim: true, maxlength: 500 }, // why admitted
  ward:        { type: String, trim: true, maxlength: 80 },  // ward / cage / kennel no.
  admittedAt:  { type: Date, default: Date.now },
  status:      { type: String, enum: ['admitted', 'discharged'], default: 'admitted', index: true },
  dischargedAt:{ type: Date, default: null },
  dischargeSummary: { type: String, trim: true, maxlength: 1000, default: null },

  dailyLogs: { type: [dailyLogSchema], default: [] },

  // Optional running cost the clinic tracks for the stay (their own figure).
  estimatedCost: { type: Number, min: 0, default: null },

  createdByName:    { type: String, trim: true, maxlength: 120, default: null },
  dischargedByName: { type: String, trim: true, maxlength: 120, default: null },
}, { timestamps: true });

hospitalizationSchema.index({ vet: 1, status: 1, admittedAt: -1 });
hospitalizationSchema.index({ vet: 1, patient: 1, admittedAt: -1 });

export default mongoose.model('Hospitalization', hospitalizationSchema);
