import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: './mobile_backend/.env' });

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      // Modern Mongoose 6+ doesn't need deprecated options
      dbName: 'xpress_vet_db',
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1); // Exit with failure
  }
};

export default connectDB;