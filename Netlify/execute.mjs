// ═══════════════════════════════════════════════════════════
// FLOWISE ENGINE — Netlify Function
// Menerima workflow JSON → eksekusi node satu per satu → return hasil
// ═══════════════════════════════════════════════════════════

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } 
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { workflow, startNodeId, inputData = {} } = body;
  if (!workflow?.nodes || !workflow?.edges) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid workflow structure' }) };
  }

  const engine = new WorkflowEngine(workflow);
  const result = await engine.run(startNodeId, inputData);
  return { statusCode: 200, headers, body: JSON.stringify(result) };
};

// ═══════════════════════════════════════════════════════════
// WORKFLOW ENGINE
// ═══════════════════════════════════════════════════════════
class WorkflowEngine {
  constructor(workflow) {
    this.nodes = workflow.nodes;
    this.edges = workflow.edges;
    this.execLog = [];
    this.nodeOutputs = {}; // nodeId → output data
  }

  async run(startNodeId, inputData) {
    // Tentukan urutan eksekusi (topological sort)
    const order = this.topoSort(startNodeId);
    this.nodeOutputs['__input__'] = [{ json: inputData }];

    for (const nodeId of order) {
      const node = this.nodes.find(n => n.id === nodeId);
      if (!node) continue;
      if (node.disabled) {
        this.execLog.push({ nodeId, label: node.label, status: 'skipped', output: [] });
        this.nodeOutputs[nodeId] = this.getInputFor(nodeId);
        continue;
      }

      const inputItems = this.getInputFor(nodeId);
      const t0 = Date.now();
      let output, error;

      try {
        output = await this.execNode(node, inputItems);
        this.nodeOutputs[nodeId] = output;
        this.execLog.push({ nodeId, label: node.label, status: 'success', itemCount: output.length, ms: Date.now() - t0, output });
      } catch (err) {
        error = err.message || String(err);
        this.nodeOutputs[nodeId] = [];
        this.execLog.push({ nodeId, label: node.label, status: 'error', error, ms: Date.now() - t0 });
        // Stop on error unless continueOnFail
        if (!node.continueOnFail) break;
      }
    }

    return { success: true, log: this.execLog, outputs: this.nodeOutputs };
  }

  // Ambil output node sebelumnya sebagai input node ini
  getInputFor(nodeId) {
    const inEdges = this.edges.filter(e => e.t === nodeId);
    if (!inEdges.length) return [{ json: {} }];
    const items = [];
    for (const edge of inEdges) {
      const out = this.nodeOutputs[edge.f] || [];
      items.push(...out);
    }
    return items.length ? items : [{ json: {} }];
  }

  // Topological sort dari startNode
  topoSort(startId) {
    const visited = new Set();
    const order = [];
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      // Kunjungi semua node yang bergantung pada ini dulu
      const outEdges = this.edges.filter(e => e.f === id);
      order.push(id);
      for (const e of outEdges) visit(e.t);
    };
    // Jika tidak ada startId, mulai dari trigger node
    const start = startId || this.nodes.find(n => n.trigger)?.id || this.nodes[0]?.id;
    if (start) visit(start);
    // Tambahkan node yang belum tercakup
    for (const n of this.nodes) if (!visited.has(n.id)) visit(n.id);
    return order;
  }

  // ═══ EKSEKUTOR TIAP NODE ═══
  async execNode(node, inputItems) {
    const p = this.getParams(node);
    const defId = node.defId;

    // ── TRIGGERS (return input langsung) ──
    if (['manual', 'webhook', 'schedule', 'form_t', 'chat_t', 'gmail_t', 'sheets_t'].includes(defId)) {
      return inputItems;
    }

    // ── HTTP REQUEST ──
    if (defId === 'http') {
      const results = [];
      for (const item of inputItems) {
        const url = this.expr(p.URL, item);
        const method = p.Method || 'GET';
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (['POST','PUT','PATCH'].includes(method) && p['Body (JSON)']) {
          try { opts.body = JSON.stringify(JSON.parse(this.expr(p['Body (JSON)'], item))); }
          catch { opts.body = this.expr(p['Body (JSON)'], item); }
        }
        if (p.Headers && p.Headers !== '{}') {
          try { Object.assign(opts.headers, JSON.parse(this.expr(p.Headers, item))); } catch {}
        }
        const resp = await fetch(url, opts);
        let data;
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('application/json')) data = await resp.json();
        else data = { text: await resp.text() };
        results.push({ json: { statusCode: resp.status, body: data, headers: Object.fromEntries(resp.headers) }, pairedItem: item });
      }
      return results;
    }

    // ── CODE (JavaScript) ──
    if (defId === 'code') {
      const code = p.Code || 'return $input.all();';
      const results = [];
      for (const item of inputItems) {
        const $input = {
          all: () => inputItems,
          first: () => inputItems[0],
          item,
          json: item.json,
        };
        const $json = item.json;
        const $now = new Date().toISOString();
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('$input', '$json', '$now', 'item', code);
          const out = fn($input, $json, $now, item);
          if (Array.isArray(out)) results.push(...out);
          else if (out) results.push({ json: out });
        } catch (e) {
          throw new Error(`Code node error: ${e.message}`);
        }
      }
      return results.length ? results : inputItems;
    }

    // ── SET / EDIT FIELDS ──
    if (defId === 'set') {
      return inputItems.map(item => {
        const name = this.expr(p['Field Name'] || '', item);
        const value = this.expr(p['Field Value'] || '', item);
        const keep = p['Keep Original Fields'] !== false;
        const json = keep ? { ...item.json } : {};
        if (name) json[name] = value;
        return { json };
      });
    }

    // ── IF ──
    if (defId === 'if') {
      const trueItems = [], falseItems = [];
      for (const item of inputItems) {
        const val = this.expr(p['Condition Value'] || '', item);
        const cmp = this.expr(p['Compare To'] || '', item);
        const op = p.Operation || 'Equals';
        let result = false;
        if (op === 'Equals') result = String(val) === String(cmp);
        else if (op === 'Not Equals') result = String(val) !== String(cmp);
        else if (op === 'Contains') result = String(val).includes(String(cmp));
        else if (op === 'Greater Than') result = Number(val) > Number(cmp);
        else if (op === 'Less Than') result = Number(val) < Number(cmp);
        else if (op === 'Is Empty') result = !val || val === '' || val === null;
        else if (op === 'Regex') result = new RegExp(cmp).test(String(val));
        if (result) trueItems.push(item); else falseItems.push(item);
      }
      // Return sebagai nested array [true_branch, false_branch]
      return [...trueItems, ...falseItems];
    }

    // ── MERGE ──
    if (defId === 'merge') return inputItems;

    // ── LOOP OVER ITEMS ──
    if (defId === 'loop') return inputItems;

    // ── WAIT ──
    if (defId === 'wait') {
      const amt = parseInt(p.Amount || '1');
      const unit = p.Unit || 'Seconds';
      const ms = unit === 'Seconds' ? amt * 1000 : unit === 'Minutes' ? amt * 60000 : unit === 'Hours' ? amt * 3600000 : amt * 86400000;
      await new Promise(r => setTimeout(r, Math.min(ms, 9000))); // max 9s untuk Netlify
      return inputItems;
    }

    // ── STOP AND ERROR ──
    if (defId === 'stop') throw new Error(p['Error Message'] || 'Workflow stopped');

    // ── NO OPERATION ──
    if (defId === 'noop') return inputItems;

    // ── RESPOND TO WEBHOOK ──
    if (defId === 'respond') return inputItems;

    // ── WHATSAPP FONNTE ──
    if (defId === 'wa_fonnte') {
      const results = [];
      for (const item of inputItems) {
        const token = this.expr(p['Fonnte Token'] || '', item);
        const target = this.expr(p['Target Number'] || '', item);
        const message = this.expr(p.Message || '', item);
        if (!token || !target) throw new Error('Fonnte: Token dan Target Number wajib diisi');
        const resp = await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, message, countryCode: '62' }),
        });
        const data = await resp.json();
        results.push({ json: { sent: true, target, message, response: data } });
      }
      return results;
    }

    // ── WHATSAPP TWILIO ──
    if (defId === 'wa_twilio') {
      const results = [];
      for (const item of inputItems) {
        const sid = this.expr(p['Account SID'] || '', item);
        const token = this.expr(p['Auth Token'] || '', item);
        const from = this.expr(p.From || '', item);
        const to = this.expr(p.To || '', item);
        const body = this.expr(p.Message || '', item);
        const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: from, To: to, Body: body }),
        });
        const data = await resp.json();
        results.push({ json: data });
      }
      return results;
    }

    // ── GMAIL (via API) ──
    if (defId === 'gmail') {
      // Butuh OAuth token dari credentials
      throw new Error('Gmail node butuh OAuth2 credential. Gunakan HTTP Request node dengan Bearer token Gmail API.');
    }

    // ── GOOGLE SHEETS ──
    if (defId === 'sheets') {
      const op = p.Operation || 'Read';
      const docId = this.expr(p['Document ID'] || '', inputItems[0]);
      const sheet = this.expr(p['Sheet Name'] || 'Sheet1', inputItems[0]);
      const apiKey = node.credentials?.sheetsApiKey;
      if (!apiKey) throw new Error('Google Sheets: API Key belum diset di credentials');
      const results = [];
      if (op === 'Read' || op === 'Get Many') {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${sheet}?key=${apiKey}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) throw new Error(`Sheets error: ${data.error.message}`);
        const rows = data.values || [];
        const headers = rows[0] || [];
        for (let i = 1; i < rows.length; i++) {
          const obj = {};
          headers.forEach((h, j) => { obj[h] = rows[i][j] || ''; });
          results.push({ json: obj });
        }
      } else if (op === 'Append') {
        const values = inputItems.map(item => Object.values(item.json));
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${sheet}:append?valueInputOption=USER_ENTERED&key=${apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        });
        const data = await resp.json();
        results.push({ json: data });
      }
      return results.length ? results : inputItems;
    }

    // ── TELEGRAM ──
    if (defId === 'telegram') {
      const results = [];
      for (const item of inputItems) {
        const botToken = node.credentials?.telegramToken || '';
        const chatId = this.expr(p['Chat ID'] || '', item);
        const text = this.expr(p.Text || '', item);
        const parseMode = p['Parse Mode'] || 'HTML';
        if (!botToken) throw new Error('Telegram: Bot Token belum diset di credentials');
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
        });
        const data = await resp.json();
        results.push({ json: data });
      }
      return results;
    }

    // ── SLACK ──
    if (defId === 'slack') {
      const results = [];
      for (const item of inputItems) {
        const webhookUrl = node.credentials?.slackWebhook || '';
        const channel = this.expr(p.Channel || '#general', item);
        const message = this.expr(p.Message || '', item);
        const username = p.Username || 'n8n Bot';
        if (!webhookUrl) throw new Error('Slack: Webhook URL belum diset di credentials');
        const resp = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, text: message, username }),
        });
        results.push({ json: { sent: true, channel, message } });
      }
      return results;
    }

    // ── OPENAI ──
    if (defId === 'openai') {
      const results = [];
      for (const item of inputItems) {
        const apiKey = node.credentials?.openaiKey || '';
        if (!apiKey) throw new Error('OpenAI: API Key belum diset di credentials');
        const model = p.Model || 'gpt-4o-mini';
        const system = this.expr(p['System Prompt'] || 'You are a helpful assistant.', item);
        const userMsg = this.expr(p['User Message'] || '', item);
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }], max_tokens: parseInt(p['Max Tokens'] || '1024'), temperature: parseFloat(p.Temperature || '0.7') }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
        results.push({ json: { text: data.choices[0].message.content, model, usage: data.usage } });
      }
      return results;
    }

    // ── GROQ ──
    if (defId === 'groq') {
      const results = [];
      for (const item of inputItems) {
        const apiKey = node.credentials?.groqKey || '';
        if (!apiKey) throw new Error('Groq: API Key belum diset di credentials');
        const model = p.Model || 'llama-3.3-70b-versatile';
        const system = this.expr(p['System Prompt'] || 'You are a helpful assistant.', item);
        const userMsg = this.expr(p['User Message'] || '', item);
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }], temperature: parseFloat(p.Temperature || '0.7') }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(`Groq: ${data.error.message || JSON.stringify(data.error)}`);
        results.push({ json: { text: data.choices[0].message.content, model, usage: data.usage } });
      }
      return results;
    }

    // ── CLAUDE (Anthropic) ──
    if (defId === 'claude') {
      const results = [];
      for (const item of inputItems) {
        const apiKey = node.credentials?.anthropicKey || '';
        if (!apiKey) throw new Error('Claude: API Key belum diset di credentials');
        const model = p.Model || 'claude-sonnet-4-6';
        const system = this.expr(p['System Prompt'] || 'You are a helpful assistant.', item);
        const userMsg = this.expr(p.Message || '', item);
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, system, messages: [{ role: 'user', content: userMsg }], max_tokens: parseInt(p['Max Tokens'] || '1024') }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(`Claude: ${data.error.message}`);
        results.push({ json: { text: data.content[0].text, model } });
      }
      return results;
    }

    // ── GOOGLE GEMINI ──
    if (defId === 'gemini') {
      const results = [];
      for (const item of inputItems) {
        const apiKey = node.credentials?.geminiKey || '';
        if (!apiKey) throw new Error('Gemini: API Key belum diset di credentials');
        const model = p.Model || 'gemini-2.0-flash';
        const prompt = this.expr(p.Prompt || '', item);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(`Gemini: ${data.error.message}`);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        results.push({ json: { text, model } });
      }
      return results;
    }

    // ── REDIS (Upstash) ──
    if (defId === 'upstash' || defId === 'redis') {
      const results = [];
      for (const item of inputItems) {
        const restUrl = this.expr(p['REST URL'] || node.credentials?.upstashUrl || '', item);
        const token = this.expr(p['REST Token'] || node.credentials?.upstashToken || p.Token || '', item);
        const op = p.Operation || p.Op || 'Get';
        const key = this.expr(p.Key || '', item);
        const value = this.expr(p.Value || '', item);
        if (!restUrl || !token) throw new Error('Upstash: REST URL dan Token wajib diisi');
        let cmd;
        if (op === 'Get') cmd = ['GET', key];
        else if (op === 'Set') cmd = ['SET', key, value];
        else if (op === 'Del' || op === 'Delete') cmd = ['DEL', key];
        else if (op === 'Expire') cmd = ['EXPIRE', key, value || '3600'];
        else cmd = [op.toUpperCase(), key, value].filter(Boolean);
        const resp = await fetch(`${restUrl}/${cmd.map(encodeURIComponent).join('/')}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await resp.json();
        results.push({ json: { result: data.result, command: cmd } });
      }
      return results;
    }

    // ── JSONBIN ──
    if (defId === 'jsonbin') {
      const results = [];
      for (const item of inputItems) {
        const op = p.Operation || p.Op || 'Read';
        const binId = this.expr(p['Bin ID'] || '', item);
        const apiKey = this.expr(p['API Key'] || node.credentials?.jsonbinKey || '', item);
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['X-Master-Key'] = apiKey;
        const base = `https://api.jsonbin.io/v3/b/${binId}`;
        let resp;
        if (op === 'Read') {
          resp = await fetch(`${base}/latest`, { headers });
        } else if (op === 'Update') {
          let dataToSend;
          try { dataToSend = JSON.parse(this.expr(p.Data || '{}', item)); } catch { dataToSend = item.json; }
          resp = await fetch(base, { method: 'PUT', headers, body: JSON.stringify(dataToSend) });
        } else if (op === 'Create') {
          let dataToSend;
          try { dataToSend = JSON.parse(this.expr(p.Data || '{}', item)); } catch { dataToSend = item.json; }
          resp = await fetch('https://api.jsonbin.io/v3/b', { method: 'POST', headers, body: JSON.stringify(dataToSend) });
        }
        const data = await resp.json();
        results.push({ json: data.record || data });
      }
      return results;
    }

    // ── JSON TRANSFORM ──
    if (defId === 'json') {
      return inputItems.map(item => {
        const op = p.Operation || p.Op || 'Parse String';
        const data = this.expr(p.Data || '', item);
        if (op === 'Parse String') {
          try { return { json: { parsed: JSON.parse(data) } }; }
          catch { throw new Error(`JSON Parse error: invalid JSON string`); }
        } else {
          return { json: { stringified: JSON.stringify(item.json) } };
        }
      });
    }

    // ── DATE & TIME ──
    if (defId === 'datetime') {
      return inputItems.map(item => {
        const action = p.Action || 'Format';
        const date = new Date(this.expr(p.Date || new Date().toISOString(), item));
        if (action === 'Format') {
          return { json: { formatted: date.toLocaleString('id-ID', { timeZone: p.Timezone || 'Asia/Jakarta' }), iso: date.toISOString(), timestamp: date.getTime() } };
        } else if (action === 'Now') {
          return { json: { now: new Date().toISOString(), timestamp: Date.now() } };
        }
        return { json: { date: date.toISOString() } };
      });
    }

    // ── CRYPTO ──
    if (defId === 'crypto') {
      const results = [];
      for (const item of inputItems) {
        const value = this.expr(p.Value || '', item);
        const algo = p.Algorithm || 'SHA256';
        // Web Crypto API
        const encoder = new TextEncoder();
        const data = encoder.encode(value);
        const algoMap = { MD5: null, SHA256: 'SHA-256', SHA512: 'SHA-512' };
        if (!algoMap[algo]) throw new Error(`${algo} tidak didukung di Netlify Functions`);
        const hashBuffer = await crypto.subtle.digest(algoMap[algo], data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        results.push({ json: { hash: hashHex, algorithm: algo, input: value } });
      }
      return results;
    }

    // ── NODE TIDAK DIKENALI ──
    return inputItems.map(item => ({ json: { ...item.json, _node: node.label, _note: 'Node executed (pass-through)' } }));
  }

  // Resolve ekspresi {{ $json.field }} atau nilai biasa
  expr(template, item) {
    if (typeof template !== 'string') return template;
    return template.replace(/=?\{\{([^}]+)\}\}/g, (_, expr) => {
      const trimmed = expr.trim();
      try {
        const $json = item?.json || {};
        const $now = new Date().toISOString();
        const $timestamp = Date.now();
        // eslint-disable-next-line no-new-func
        return new Function('$json', '$now', '$timestamp', `return ${trimmed}`)($json, $now, $timestamp);
      } catch {
        return '';
      }
    });
  }

  // Ambil params sebagai object key→value
  getParams(node) {
    const out = {};
    for (const p of node.params || []) out[p.k] = p.v;
    return out;
  }
}
