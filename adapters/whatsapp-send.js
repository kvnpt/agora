// Outbound WhatsApp sender — Meta Cloud API.
// Used for ACK-on-receipt, result reply, and ambiguity clarifier.
// Fire-and-forget: never throws, never blocks batch processing.

const GRAPH_VERSION = 'v21.0';

async function sendText(to, body, { runId = null } = {}) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log(`[wa-send] skipped (no creds): to=${to} runId=${runId} body="${String(body || '').slice(0, 40)}"`);
    return { ok: false, skipped: true };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: String(body || '').slice(0, 4096), preview_url: true }
  };

  const attempt = async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return resp;
  };

  let resp;
  try {
    resp = await attempt();
  } catch (err) {
    await new Promise(r => setTimeout(r, 1000));
    try { resp = await attempt(); }
    catch (err2) {
      console.error(`[wa-send] network failure runId=${runId} to=${to}: ${err2.message}`);
      return { ok: false, error: err2.message };
    }
  }

  // Retry once on 5xx / 429
  if (!resp.ok && (resp.status >= 500 || resp.status === 429)) {
    await new Promise(r => setTimeout(r, 1000));
    try { resp = await attempt(); }
    catch (err) {
      console.error(`[wa-send] retry network failure runId=${runId} to=${to}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  const status = resp.status;
  if (!resp.ok) {
    let errorBody = '';
    try { errorBody = await resp.text(); } catch {}
    console.error(`[wa-send] failed runId=${runId} to=${to} status=${status} body=${errorBody}`);
    return { ok: false, status, error: errorBody };
  }

  console.log(`[wa-send] sent runId=${runId} to=${to} status=${status}`);
  return { ok: true, status };
}

module.exports = { sendText };
