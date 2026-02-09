import mongoose from 'mongoose';

const ProfessionalSchema = new mongoose.Schema({
  name: { type: String, required: true },
  vcnNumber: { type: String, required: function() { return this.role === 'vet'; } },
  role: { type: String, enum: ['vet', 'kennel'], required: true },
  phone: { type: String },
  email: { type: String },
  // Add other info fields as needed
  // Remove document fields
}, { timestamps: true });

export default mongoose.model('Professional', ProfessionalSchema);
