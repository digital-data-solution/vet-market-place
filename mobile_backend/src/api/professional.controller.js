import Professional from '../models/Professional.js';

export const onboardProfessional = async (req, res) => {
  try {
    const { businessName, address, specialization, role } = req.body;
    if (!businessName || !address || !specialization || !role) {
      return res.status(400).json({ message: 'All fields are required.' });
    }
    const professional = new Professional({ businessName, address, specialization, role });
    await professional.save();
    return res.status(201).json({ message: 'Professional onboarded successfully.', data: professional });
  } catch (error) {
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
};
