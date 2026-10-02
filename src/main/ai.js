const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';

const DEFAULT_MODELS = { gemini: 'gemini-2.5-flash', grok: 'grok-4', offline: 'built-in' };

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

// ---------- Built-in offline responder (no API key needed) ----------
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const OFFLINE_KB = [
  // small talk
  [/^(hi|hello|hey|yo|hiya|howdy|sup|good\s*(morning|afternoon|evening))\b/,
    () => pick([
      'Hi! How can I help with Minecraft or the launcher today?',
      'Hello! Ask me about mods, loaders, Java, crashes, or anything Minecraft.',
      'Hey there! What can I help you with?',
    ])],
  [/how\s*(are|r)\s*(you|u|it going)|how's it going/,
    () => 'Doing great, thanks for asking! Ready to help with Minecraft or the launcher. What do you need?'],
  [/^(thanks|thank you|thx|ty|cheers)\b/,
    () => pick(['You\'re welcome! Anything else?', 'Happy to help!', 'Anytime.'])],
  [/^(bye|goodbye|see ya|cya|later)\b/,
    () => 'Goodbye! Have fun in your world.'],
  [/(your|ur)\s*(name|who are you)|what are you/,
    () => 'I\'m Moji Helper, the assistant built into Moji Launcher. Right now I\'m running in offline (built-in) mode, so I answer from an on-device knowledge base with no API key. Add a Gemini or Grok key in Settings for full open-ended answers.'],

  // launcher help
  [/install.*(mod|shader)|add.*(mod|shader)|how.*(mod|shader).*work|mod.*install/,
    () => 'To install a mod: pick your Minecraft version and a loader (Fabric/Forge/Quilt) on the Play tab, then open the Browse tab, search for the mod, and press Add. It drops into that instance\'s mods folder. Launch the game and it loads. Mods must match your loader and version.'],
  [/\b(fabric|forge|quilt|loader)\b/,
    () => 'Loaders: Fabric is lightweight and updates fast, Forge is the classic with the biggest mod library, Quilt is a community fork of Fabric. Choose one on the Play tab (the "Loader" row), pick a loader version, then launch. Each loader+version gets its own instance folder so mods never clash.'],
  [/\b(java|jdk|runtime|jre)\b/,
    () => 'The launcher auto-detects installed Java and picks the lowest version your Minecraft needs (old MC = Java 8, new MC = Java 17/21+). If none fits, it downloads one automatically. You can force a specific java.exe in Settings → Java path.'],
  [/\b(ram|memory|gb)\b/,
    () => 'Set RAM on the Play tab with the Memory slider (the "Instance" panel). 4 GB is fine for vanilla; 6-8 GB for modpacks. Don\'t allocate more than half your physical RAM or the whole PC will slow down.'],
  [/\bcrash|won'?t\s*(start|launch|open)|not\s*(launch|start|work)|fail|error\b/,
    () => 'For crashes: (1) check the Console on the Play tab for the last error lines; (2) make sure your mods match the loader AND Minecraft version; (3) try lowering RAM; (4) open the instance folder and remove recently added mods to isolate the culprit; (5) for "Java" errors let the launcher auto-pick Java. Paste the console error here and I\'ll narrow it down.'],
  [/folder|directory|where.*(mod|save|config|file)/,
    () => 'Each launch gets an instance folder with mods/, config/ and saves/. Open it with the folder icon on the left rail (or the "Instance folder" row). Shared files like the game jar, libraries and assets live in your game directory (Settings → Game directory).'],
  [/\bversion\b|snapshot|newest|latest|update.*minecraft/,
    () => 'Pick any version from the pills on the Play tab. Turn on "Snap" to include snapshots. The list refreshes automatically, so new releases show up on their own. Each version downloads its own jar, libraries and assets the first time you launch it.'],
  [/\b(username|name|skin|account|offline)\b/,
    () => 'This launcher is offline-mode: your username (top-right) is local only and gets a stable offline UUID. Skins from mojang.com won\'t load offline; use a mod like SkinSwapper or a custom resource pack instead.'],
  [/\b(world|save|seed|backup)\b/,
    () => 'Worlds save to your instance folder under saves/. To back one up, copy that world\'s folder somewhere safe; to restore, copy it back. Seeds work normally — enter them when creating a world.'],
  [/\bshader|resource\s*pack|texture\s*pack\b/,
    () => 'Resource packs go in the instance\'s resourcepacks/ folder (create it if missing) and are enabled in-game under Options → Resource Packs. Shaders need a mod: Iris (Fabric) or Oculus (Forge) plus Sodium/Rubidium for performance.'],
  [/\b(fps|lag|slow|performance|boost|optimi[sz]e)\b/,
    () => 'For better FPS: install Sodium (Fabric) or Embeddium/Rubidium (Forge), plus Lithium for game logic; add Iris/Oculus if you want shaders. Allocate enough RAM, lower render distance, and turn off fancy graphics. The launcher already starts Java with G1GC tuning flags for smoother frame pacing.'],
  [/\b(ai|gemini|grok|api\s*key|key)\b/,
    () => 'The AI Helper has three modes in Settings → AI Helper provider: Built-in (offline, no key — what you\'re using now), Gemini (free key from aistudio.google.com), and Grok (paid xAI key from console.x.ai). Built-in answers common launcher/Minecraft questions on-device; the keyed modes answer anything.'],

  // minecraft basics
  [/\b(diamond|netherite|mine|mining)\b/,
    () => 'Diamonds spawn most often around Y = -59 in modern versions; mine in the deepslate layer with an iron+ pickaxe. Netherite is in the Nether around Y = 15 — blast mine with beds or use a pickaxe. Always bring torches and watch for lava.'],
  [/\benchant\b/,
    () => 'Enchant with an enchanting table (bookshelves boost levels), an anvil + enchanted books, or a villager librarian for cheap max-level books. Key picks: Efficiency V, Fortune III (or Silk Touch), Mending, Unbreaking III.'],
  [/\b(breed|animal|farm|crop)\b/,
    () => 'Breeding: wheat for cows/sheep, carrots for pigs, seeds for chickens. Crops grow faster on hydrated farmland with light; use bone meal to speed up. Water source blocks hydrate farmland 4 blocks out.'],
  [/\b(nether|end|portal|boss|dragon|wither)\b/,
    () => 'Nether portal: 4x5 obsidian frame, light with flint & steel. End: find a stronghold, activate the portal with eyes of ender, then kill the dragon (break the crystals first). Wither: 4 soul sand in a T + 3 wither skulls, fight underground away from your base.'],
];

function offlineAnswer(question) {
  const t = String(question).toLowerCase().replace(/[\s!?.,]+$/g, '').trim();
  for (const [re, fn] of OFFLINE_KB) {
    if (re.test(t)) return fn();
  }
  return `I'm in offline (built-in) mode, so I answer from an on-device knowledge base rather than a live model — and I don't have a specific answer for "${question}". ` +
    'I can help with: installing mods, Fabric/Forge/Quilt, Java, RAM, crashes, instance folders, versions, worlds/backups, shaders, FPS, and Minecraft basics. ' +
    'For open-ended questions, add a free Gemini key (or a Grok key) in Settings → AI Helper provider.';
}

// Ask the selected provider a question with optional prior turns for context.
// history: [{ role: 'user' | 'model', text: string }]
async function ask({ question, history = [], provider = 'gemini', apiKey, model }) {
  if (provider === 'offline') return { ok: true, text: offlineAnswer(question), model: 'built-in' };
  if (!apiKey) return { ok: false, error: 'no-key' };
  const useModel = (model || '').trim() || DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini;
  const hist = buildHistory(history);
  return provider === 'grok'
    ? askGrok({ question, history: hist, apiKey, model: useModel })
    : askGemini({ question, history: hist, apiKey, model: useModel });
}

module.exports = { ask, DEFAULT_MODELS, offlineAnswer };
