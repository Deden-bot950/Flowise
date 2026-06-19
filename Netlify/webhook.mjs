// ═══════════════════════════════════════════════════════════
// WEBHOOK TRIGGER — /api/webhook/:workflowId
// Menerima request dari luar → jalankan workflow yang sesuai
// ═══════════════════════════════════════════════════════════

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Parse path: /api/webhook/{workflowId}
  const pathParts = (event.path || '').split('/').filter(Boolean);
  const workflowId = pathParts[pathParts.length - 1];

  if (!workflowId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'workflowId required in path: /api/webhook/{workflowId}' }) };
  }

  // Ambil workflow dari JSONBin (storage)
  const binUrl = `https://api.jsonbin.io/v3/b/${workflowId}/latest`;
  let workflow;
  try {
    const resp = await fetch(binUrl, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`Workflow not found: ${workflowId}`);
    const data = await resp.json();
    workflow = data.record;
  } catch (err) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: err.message }) };
  }

  // Siapkan input data dari request
  let inputData = {};
  try {
    if (event.body) inputData = JSON.parse(event.body);
  } catch {}

  // Tambahkan webhook metadata
  inputData._webhook = {
    method: event.httpMethod,
    path: event.path,
    headers: event.headers,
    queryParams: event.queryStringParameters || {},
    timestamp: new Date().toISOString(),
  };

  // Jalankan workflow
  const { handler: execHandler } = await import('./execute.mjs');
  const result = await execHandler({
    httpMethod: 'POST',
    body: JSON.stringify({ workflow, inputData }),
  });

  // Cek apakah ada Respond to Webhook node
  const resultBody = JSON.parse(result.body);
  const respondNode = workflow.nodes?.find(n => n.defId === 'respond');
  if (respondNode && resultBody.outputs) {
    const out = resultBody.outputs[respondNode.id]?.[0]?.json;
    if (out) {
      return {
        statusCode: parseInt(out.statusCode || 200),
        headers: { ...headers, ...(out.headers || {}) },
        body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body),
      };
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ received: true, workflowId, log: resultBody.log }) };
};
