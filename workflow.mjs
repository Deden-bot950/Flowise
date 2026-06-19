// ═══════════════════════════════════════════════════════════
// WORKFLOW STORAGE — simpan & load workflow ke JSONBin
// POST /api/workflow → save, GET /api/workflow/{id} → load
// ═══════════════════════════════════════════════════════════

const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Master-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const pathParts = (event.path || '').split('/').filter(Boolean);
  const binId = pathParts[pathParts.length - 1];
  const apiKey = event.headers['x-master-key'] || event.queryStringParameters?.key || '';

  const reqHeaders = { 'Content-Type': 'application/json' };
  if (apiKey) reqHeaders['X-Master-Key'] = apiKey;

  // GET — load workflow
  if (event.httpMethod === 'GET' && binId && binId !== 'workflow') {
    const resp = await fetch(`${JSONBIN_BASE}/${binId}/latest`, { headers: reqHeaders });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: resp.status, headers, body: JSON.stringify({ error: data.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ id: binId, workflow: data.record }) };
  }

  // POST — create new workflow
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const resp = await fetch(JSONBIN_BASE, {
      method: 'POST',
      headers: { ...reqHeaders, 'X-Bin-Name': body.name || 'Workflow', 'X-Bin-Private': 'false' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: resp.status, headers, body: JSON.stringify({ error: data.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ id: data.metadata.id, workflow: body }) };
  }

  // PUT — update workflow
  if (event.httpMethod === 'PUT' && binId && binId !== 'workflow') {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const resp = await fetch(`${JSONBIN_BASE}/${binId}`, {
      method: 'PUT',
      headers: reqHeaders,
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: resp.status, headers, body: JSON.stringify({ error: data.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ id: binId, saved: true }) };
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
};
