import Professional from '../models/Professional.js';

export const onboardProfessional = async (req, res) => {
  try {
    const { name, vcnNumber, role } = req.body;
    if (!name || !vcnNumber || role !== 'vet') {
      return res.status(400).json({ message: 'Name, VCN number, and role (vet) are required.' });
    }
    // Optionally: verify VCN number via external API if available
    // Save vet profile
    const professional = new Professional({ name, vcnNumber, role });
    await professional.save();
    res.status(201).json({ message: 'Veterinarian onboarded successfully', data: professional });
  } catch (error) {
    res.status(500).json({ message: 'Failed to onboard veterinarian', error: error.message });
  }
};

// Update professional profile
export async function updateProfessional(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;
    const professional = await Professional.findByIdAndUpdate(id, updates, { new: true });
    if (!professional) {
      return res.status(404).json({ message: 'Professional not found' });
    }
    res.json({ message: 'Profile updated', data: professional });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update profile', error: error.message });
  }
};

// Get professional profile
export async function getProfessional(req, res) {
  try {
    const { id } = req.params;
    const professional = await Professional.findById(id);
    if (!professional) {
      return res.status(404).json({ message: 'Professional not found' });
    }
    res.json({ data: professional });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch profile', error: error.message });
  }
};

// List all professionals
export async function listProfessionals(req, res) {
  try {
    const professionals = await Professional.find();
    res.json({ data: professionals });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch professionals', error: error.message });
  }
};
