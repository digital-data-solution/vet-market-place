import mongoose from 'mongoose';

// A vaccination (or other recurring preventive-care item, e.g. deworming)
// given to a patient, with a due date for the next dose. This is the object
// the reminder job scans daily — kept separate from TreatmentRecord because
// due-date scheduling logic is structured, not free-text.
const vaccinationRecordSchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client' }, // denormalised for fast client-history queries

  vaccineName: { type: String, required: true, trim: true, maxlength: 150 },
  dateGiven:   { type: Date, default: Date.now },
  nextDueDate: { type: Date, index: true },

  reminderSentAt: { type: Date },
  notes:          { type: String, trim: true, maxlength: 500 },

  createdByName: { type: String, trim: true, maxlength: 120, default: null }, // hospital-flow attribution
}, { timestamps: true });

vaccinationRecordSchema.index({ vet: 1, patient: 1, dateGiven: -1 });

export default mongoose.model('VaccinationRecord', vaccinationRecordSchema);
