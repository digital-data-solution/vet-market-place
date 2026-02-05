import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

const clearDatabase = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // List all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));

    // Collections to keep
    const keepCollections = ['users', 'subscriptions'];

    // Drop unwanted collections
    for (const collection of collections) {
      if (!keepCollections.includes(collection.name)) {
        await mongoose.connection.db.dropCollection(collection.name);
        console.log(`Dropped collection: ${collection.name}`);
      }
    }

    console.log('Unwanted collections removed. Kept: users, subscriptions');
    process.exit();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

clearDatabase();