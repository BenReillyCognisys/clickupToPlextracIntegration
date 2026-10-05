const api = require('../lib/plextrac-api');
const mergeStore = require('../lib/client-merge-store');
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

  // A name that was merged into another client (pipeline/client-merge) goes to that
  // client rather than recreating the duplicate. Best-effort: if the alias store can't
  // be read, the client is created as before.
  const alias = await mergeStore.findAlias(clientName).catch((err) => {
    log.warn('Plextrac client alias lookup failed — continuing without it', { client: clientName, reason: err.message });
    return null;
  });
  const aliased = alias && clients.find((c) => String(c.client_id) === String(alias.client_id));
  if (aliased) {
    log.info('Plextrac Client found via merge alias', { client: clientName, client_id: aliased.client_id, merged_into: aliased.name });
    return { clientId: aliased.client_id, clientCreated: false };
  }

  const created = await api.createClient(clientName);
  log.info('Plextrac Client created', { client: clientName, client_id: created.client_id });
  return { clientId: created.client_id, clientCreated: true };
}

module.exports = { findOrCreateClient };
