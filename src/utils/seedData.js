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
    vetDetails: { vcnNumber: "VCN/2026/8921", specialization: ["Livestock", "General Care"] },
    vetVerification: { status: 'approved', verifiedAt: new Date() }
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

const adminUser = {
  name: 'System Admin',
  email: 'admin@example.com',
  password: 'adminpassword',
  role: 'admin',
  isVerified: true
};

const shops = [
  {
    name: "Lagos Vet Clinic",
    ownerEmail: "olumide.vet@example.com",
    address: "22 Yaba Road, Lagos",
    contact: "+2348012345678",
    services: ["Consultation", "Surgery"],
    location: { type: 'Point', coordinates: [3.3833, 6.4559] }
  },
  {
    name: "Abuja Pet Care",
    ownerEmail: "amina.vet@example.com",
    address: "10 Wuse Market St, Abuja",
    contact: "+2348098765432",
    services: ["Vaccination", "General Care"],
    location: { type: 'Point', coordinates: [7.4820, 9.0660] }
  }
];

const seedDB = async () => {
  try {
    await connectDB();

    // Upsert vets
    const createdVets = [];
    for (const v of vets) {
      const existing = await User.findOne({ email: v.email });
      if (existing) {
        // update fields except password (keep existing password)
        existing.name = v.name;
        existing.role = v.role;
        existing.isVerified = v.isVerified || existing.isVerified;
        existing.location = v.location || existing.location;
        existing.vetDetails = { ...existing.vetDetails, ...v.vetDetails };
        existing.vetVerification = { ...existing.vetVerification, ...(v.vetVerification || {}) };
        await existing.save();
        createdVets.push(existing);
      } else {
        const n = await User.create(v);
        createdVets.push(n);
      }
    }

    // Upsert admin
    let admin = await User.findOne({ email: adminUser.email });
    if (admin) {
      admin.name = adminUser.name;
      admin.role = adminUser.role;
      admin.isVerified = adminUser.isVerified || admin.isVerified;
      await admin.save();
    } else {
      admin = await User.create(adminUser);
    }

    // Upsert subscriptions for vets
    for (const vet of createdVets) {
      if (vet.role === 'vet' || vet.role === 'kennel_owner') {
        const existingSub = await Subscription.findOne({ user: vet._id, plan: 'basic' });
        if (!existingSub) {
          const endDate = new Date();
          endDate.setMonth(endDate.getMonth() + 1);
          await Subscription.create({ user: vet._id, plan: 'basic', amount: 5000, endDate });
        }
      }
    }

    // Upsert shops linked to vets
    const Shop = (await import('../models/Shop.js')).default;
    for (const s of shops) {
      const owner = await User.findOne({ email: s.ownerEmail });
      if (!owner) continue;
      const existingShop = await Shop.findOne({ name: s.name, owner: owner._id });
      if (existingShop) {
        existingShop.address = s.address;
        existingShop.contact = s.contact;
        existingShop.services = s.services;
        existingShop.location = s.location;
        existingShop.isVerified = true;
        await existingShop.save();
      } else {
        await Shop.create({ name: s.name, owner: owner._id, address: s.address, contact: s.contact, services: s.services, location: s.location, isVerified: true });
      }
    }

    console.log('✅ Database seeded (idempotent).');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding Error:', error);
    process.exit(1);
  }
};

seedDB();