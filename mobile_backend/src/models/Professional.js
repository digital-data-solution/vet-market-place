import mongoose from 'mongoose';

const ProfessionalSchema = new mongoose.Schema({
  businessName: { type: String, required: true },
  address: { type: Object, required: true },
  specialization: { type: String, required: true },
  role: { type: String, enum: ['vet', 'kennel_owner'], required: true },
}, { timestamps: true });

export default mongoose.model('Professional', ProfessionalSchema);
