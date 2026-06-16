const api = require('../lib/plextrac-api');
const log = require('../lib/logger');

/**
 * Normalises the Plextrac client list response.
 * The API returns objects shaped as: { id: "client_1254", data: [1254, "Name", null] }
 */
function normaliseClients(raw) {
  return (raw || []).map(c => {
    if (Array.isArray(c.data) && c.data.length >= 2) {
      return { client_id: c.data[0], name: String(c.data[1] || '') };
    }
    return { client_id: c.client_id || c.id, name: String(c.name || '') };
  });
}

async function findOrCreateClient(clientName) {
  const raw = await api.listClients();
  const clients = normaliseClients(raw);

  const match = clients.find(
    c => c.name.trim().toLowerCase() === clientName.trim().toLowerCase()
  );

  if (match) {
    log.info('Plextrac Client found', { client: clientName, client_id: match.client_id });
    return { clientId: match.client_id, clientCreated: false };
  }

  const created = await api.createClient(clientName);
  log.info('Plextrac Client created', { client: clientName, client_id: created.client_id });
  return { clientId: created.client_id, clientCreated: true };
}

module.exports = { findOrCreateClient };
