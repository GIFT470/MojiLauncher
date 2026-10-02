const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_MODEL = 'gemini-2.5-flash';

// A launcher-aware but general-purpose assistant: the user can ask it anything.
const SYSTEM_INSTRUCTION =
  'You are "Moji Helper", the built-in assistant inside the Moji Launcher, a Minecraft launcher. ' +
  'Answer any question the user asks — Minecraft, mods, troubleshooting, or anything else — clearly and concisely. ' +
  'When the question is about Minecraft or this launcher, favour practical, step-by-step help. ' +
  'Keep answers short and scannable unless the user asks for detail. Use plain text with simple markdown.';

// Ask Gemini a question with optional prior turns for context.
// history: [{ role: 'user' | 'model', text: string }]
async function ask({ question, history = [], apiKey, model }) {
  if (!apiKey) return { ok: false, error: 'no-key' };
  const useModel = (model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const contents = [];
  for (const turn of history.slice(-12)) {
    if (!turn || !turn.text) continue;
    contents.push({ role: turn.role === 'model' ? 'model' : 'user', parts: [{ text: String(turn.text) }] });
  }
  contents.push({ role: 'user', parts: [{ text: String(question) }] });

  const url = `${GEMINI_BASE}/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(raw);
      message = j?.error?.message || message;
    } catch {}
    return { ok: false, error: message, status: res.status };
  }

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
  return { ok: true, text, model: useModel };
}

module.exports = { ask, DEFAULT_MODEL };
