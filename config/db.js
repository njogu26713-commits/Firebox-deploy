const mongoose = require('mongoose');
const config = require('./config');

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 8000,
    });
    isConnected = true;
    console.log(`[db] connected to MongoDB → ${maskUri(config.mongoUri)}`);
  } catch (err) {
    console.error('[db] MongoDB connection failed:', err.message);
    console.error('[db] Firebox Deploy requires MongoDB to be running. Retrying in 5s...');
    setTimeout(connectDB, 5000);
  }

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    console.warn('[db] MongoDB disconnected');
  });

  return mongoose.connection;
}

function maskUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

module.exports = connectDB;
