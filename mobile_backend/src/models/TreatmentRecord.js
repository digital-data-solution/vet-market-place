import mongoose from 'mongoose';

// A single visit/treatment entry in a patient's clinical history.
// followUpDate (optional) is what drives the general follow-up reminder in
// jobs/practiceReminders.js — vaccinations use the dedicated
// VaccinationRecord model instead since they need structured due-date logic.
const treatmentRecordSchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client' }, // denormalised for fast client-history queries

  date: { type: Date, default: Date.now },

  reason:      { type: String, trim: true, maxlength: 300 }, // reason for visit
  diagnosis:   { type: String, trim: true, maxlength: 500 },
  treatment:   { type: String, trim: true, maxlength: 1000 },
  medications: { type: String, trim: true, maxlength: 500 },
  weightKg:    { type: Number, min: 0 }, // weight at this visit
  notes:       { type: String, trim: true, maxlength: 1000 },

  followUpDate:           { type: Date, index: true },
  followUpReminderSentAt: { type: Date },
}, { timestamps: true });

treatmentRecordSchema.index({ vet: 1, patient: 1, date: -1 });

export default mongoose.model('TreatmentRecord', treatmentRecordSchema);
