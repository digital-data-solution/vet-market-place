import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import connectDB from '../lib/db.js';

dotenv.config({ path: './.env' });

const vets = [
  {
    name: "Dr. Olumide Adebayo",
    email: "olumide.vet@example.com",
    password: "password123",
    role: "vet",
    isVerified: true,
    location: { type: "Point", coordinates: [3.3841, 6.4550] }, // Lagos (Yaba)
    vetDetails: { vcnNumber: "VCN/2026/1042", specialization: ["Surgery", "Vaccination"] }
  },
  {
    name: "Dr. Amina Ibrahim",
    email: "amina.vet@example.com",
    password: "password123",
    role: "vet",
    isVerified: true,
    location: { type: "Point", coordinates: [7.4833, 9.0667] }, // Abuja (Wuse)
    vetDetails: { vcnNumber: "VCN/2026/8921", specialization: ["Livestock", "General Care"] }
  },
  {
    name: "Nnamdi's Elite Kennels",
    email: "nnamdi.kennels@example.com",
    password: "password123",
    role: "kennel_owner",
    isVerified: true,
    location: { type: "Point", coordinates: [7.0336, 4.8242] }, // Port Harcourt
    kennelDetails: { cacNumber: "RC-892341", capacity: 15 }
  }
];

const seedDB = async () => {
  try {
    await connectDB();
    await User.deleteMany({ role: { $ne: 'admin' } });
    await Subscription.deleteMany();
    const createdVets = await User.create(vets);

    // Create sample subscriptions
    for (const vet of createdVets) {
      if (vet.role === 'vet' || vet.role === 'kennel_owner') {
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1);
        await Subscription.create({
          user: vet._id,
          plan: 'basic',
          amount: 5000,
          endDate
        });
      }
    }

    console.log("✅ Database Seeded with Nigerian Vets, Kennels, and Subscriptions!");
    process.exit();
  } catch (error) {
    console.error("❌ Seeding Error:", error);
    process.exit(1);
  }
};

seedDB();