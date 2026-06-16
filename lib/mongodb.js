const { MongoClient } = require('mongodb');

let _db = null;

async function getDb() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');
  const client = new MongoClient(uri);
  await client.connect();
  _db = client.db(process.env.MONGODB_DB || 'clickup_plextrac');
  return _db;
}

module.exports = { getDb };
