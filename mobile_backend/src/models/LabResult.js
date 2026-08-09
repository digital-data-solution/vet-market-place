import mongoose from 'mongoose';

// A laboratory result attached to a patient's clinical history — for clinics
// that run their own lab (bloodwork, urinalysis, cytology, imaging, etc.).
// Mirrors TreatmentRecord's tenant scoping (vet + patient + denormalised client).
// The actual report file (PDF/photo) is uploaded to Cloudinary via the existing
// /api/upload endpoint and its URL stored in attachmentUrl.
const labResultSchema = new mongoose.Schema({
  vet:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  client:  { type: mongoose.Schema.Types.ObjectId, ref: 'Client' }, // denormalised for client-history queries

  testName:   { type: String, required: true, trim: true, maxlength: 200 }, // e.g. "Complete Blood Count"
  sampleType: { type: String, trim: true, maxlength: 100 },                 // e.g. "Blood", "Urine", "Swab"
  results:    { type: String, trim: true, maxlength: 4000 },                // free-text values / findings
  referenceRange: { type: String, trim: true, maxlength: 1000 },           // normal ranges, optional

  status: { type: String, enum: ['pending', 'normal', 'abnormal', 'inconclusive'], default: 'pending', index: true },

  performedAt:    { type: Date, default: Date.now },
  technicianName: { type: String, trim: true, maxlength: 120 },
  attachmentUrl:  { type: String, trim: true }, // Cloudinary URL of the report (PDF/photo)
  notes:          { type: String, trim: true, maxlength: 1000 },

  createdByName: { type: String, trim: true, maxlength: 120, default: null }, // who logged it in (auto from login)
}, { timestamps: true });

labResultSchema.index({ vet: 1, patient: 1, performedAt: -1 });

export default mongoose.model('LabResult', labResultSchema);
