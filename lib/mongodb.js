const { MongoClient } = require('mongodb');

let _client = null;
let _db = null;

async function getDb() {
  // If we have a live connection, return it
  if (_db && _client?.topology?.isConnected()) return _db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  // Reset stale state before reconnecting
  _db = null;
  _client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await _client.connect();
  _db = _client.db(process.env.MONGODB_DB || 'clickup_plextrac');
  return _db;
}

module.exports = { getDb };
