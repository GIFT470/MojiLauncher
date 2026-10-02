const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';

const DEFAULT_MODELS = { gemini: 'gemini-2.5-flash', grok: 'grok-4' };

// A launcher-aware but general-purpose assistant: the user can ask it anything.
const SYSTEM_INSTRUCTION =
  'You are "Moji Helper", the built-in assistant inside the Moji Launcher, a Minecraft launcher. ' +
  'Answer any question the user asks — Minecraft, mods, troubleshooting, or anything else — clearly and concisely. ' +
  'When the question is about Minecraft or this launcher, favour practical, step-by-step help. ' +
  'Keep answers short and scannable unless the user asks for detail. Use plain text with simple markdown.';

function httpError(raw, status) {
  let message = `HTTP ${status}`;
  try {
    const j = JSON.parse(raw);
    // Gemini nests {error:{message}}; xAI returns {error:"string"}.
    message = (typeof j?.error === 'string' ? j.error : j?.error?.message) || message;
  } catch {}
  return { ok: false, error: message, status };
}

function buildHistory(history) {
  const out = [];
  for (const turn of (history || []).slice(-12)) {
    if (!turn || !turn.text) continue;
    out.push({ role: turn.role === 'model' ? 'model' : 'user', text: String(turn.text) });
  }
  return out;
}

async function askGemini({ question, history, apiKey, model }) {
  const contents = history.map(t => ({ role: t.role, parts: [{ text: t.text }] }));
  contents.push({ role: 'user', parts: [{ text: String(question) }] });

  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 1024 },
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }

  const raw = await res.text();
  if (!res.ok) return httpError(raw, res.status);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed response from Gemini.' };
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  const blocked = data?.candidates?.[0]?.finishReason;
  if (!text) {
    return {
      ok: false,
      error: blocked && blocked !== 'STOP'
        ? `Gemini returned no text (finish reason: ${blocked}).`
        : 'Gemini returned an empty answer.',
    };
  }
  return { ok: true, text, model };
}

async function askGrok({ question, history, apiKey, model }) {
  const messages = [{ role: 'system', content: SYSTEM_INSTRUCTION }];
  for (const t of history) messages.push({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text });
  messages.push({ role: 'user', content: String(question) });

  let res;
  try {
    res = await fetch(GROK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1024 }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }

  const raw = await res.text();
  if (!res.ok) return httpError(raw, res.status);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed response from Grok.' };
  }

  const text = (data?.choices?.[0]?.message?.content || '').trim();
  if (!text) return { ok: false, error: 'Grok returned an empty answer.' };
  return { ok: true, text, model };
}

// Ask the selected provider a question with optional prior turns for context.
// history: [{ role: 'user' | 'model', text: string }]
async function ask({ question, history = [], provider = 'gemini', apiKey, model }) {
  if (!apiKey) return { ok: false, error: 'no-key' };
  const useModel = (model || '').trim() || DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini;
  const hist = buildHistory(history);
  return provider === 'grok'
    ? askGrok({ question, history: hist, apiKey, model: useModel })
    : askGemini({ question, history: hist, apiKey, model: useModel });
}

module.exports = { ask, DEFAULT_MODELS };
