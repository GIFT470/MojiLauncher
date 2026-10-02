const $ = id => document.getElementById(id);
const api = window.launcher;

let allVersions = [];
let loaderVersions = [];
let selectedVersionId = '';
let busy = false;
let cfKey = '';
let geminiKey = '';
let browseSource = 'modrinth';
let browseType = 'mod';
let browseQuery = '';
let browseTimer = null;
let lastSearchKey = '';

const PHASE_LABEL = {
  java: 'Preparing Java',
  version: 'Loading version',
  loader: 'Preparing mod loader',
  libraries: 'Downloading files',
  assets: 'Downloading assets',
  natives: 'Extracting natives',
  launch: 'Launching',
};

const LOADER_META = {
  vanilla: { name: 'Vanilla', sub: 'No mod loader', color: 'gray' },
  fabric: { name: 'Fabric', sub: 'Lightweight modding toolchain', color: 'yellow' },
  quilt: { name: 'Quilt', sub: 'Community fork of Fabric', color: 'purple' },
  forge: { name: 'Forge', sub: 'Classic modding framework', color: 'orange' },
};

// Console rendering is batched: game/launch output can arrive hundreds of lines
// per second, and touching the DOM per line (textContent +=, split, scrollHeight)
// caused visible lag spikes. We buffer text, flush once per animation frame, append
// a single text node, and trim whole nodes instead of re-splitting the buffer.
const logEl = $('log');
const logCountEl = $('log-count');
const LOG_MAX_LINES = 2000;
let logNodes = [];      // { node, lines } oldest first
let logLineCount = 0;
let logPending = '';
let logRaf = 0;
let logAtBottom = true;

logEl.addEventListener('scroll', () => {
  logAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
}, { passive: true });

function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function flushLog() {
  logRaf = 0;
  if (!logPending) return;
  let chunk = logPending;
  logPending = '';
  let added = countNewlines(chunk);
  // Bound a single flush: if the window was hidden, lines can pile up between
  // frames. Never append more than the cap at once, or one frame hitch-spikes.
  if (added > LOG_MAX_LINES) {
    const lines = chunk.split('\n');
    chunk = lines.slice(lines.length - LOG_MAX_LINES).join('\n');
    added = countNewlines(chunk);
  }
  const node = document.createTextNode(chunk);
  logEl.appendChild(node);
  logNodes.push({ node, lines: added });
  logLineCount += added;
  while (logLineCount > LOG_MAX_LINES && logNodes.length > 1) {
    const old = logNodes.shift();
    old.node.remove();
    logLineCount -= old.lines;
  }
  logCountEl.textContent = `${logLineCount} lines`;
  if (logAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

function log(text) {
  logPending += text.endsWith('\n') ? text : text + '\n';
  if (!logRaf) logRaf = requestAnimationFrame(flushLog);
}

function clearLog() {
  if (logRaf) { cancelAnimationFrame(logRaf); logRaf = 0; }
  logPending = '';
  logNodes = [];
  logLineCount = 0;
  logEl.textContent = '';
  logCountEl.textContent = '0 lines';
}

function setStatus(title, sub) {
  $('status-title').textContent = title;
  $('status-sub').textContent = sub;
}

function setStatusIdle() {
  if (busy) return;
  if (!selectedVersionId) {
    setStatus('Loading versions...', 'Fetching manifest');
    return;
  }
  setStatus('Ready to play', `${selectedVersionId} · ${LOADER_META[currentLoader()].name} · offline`);
}

function setBusy(isBusy) {
  busy = isBusy;
  $('play').disabled = isBusy;
  updateLaunchLabel();
  $('progress-wrap').classList.toggle('hidden', !isBusy);
  $('status-pill').classList.toggle('busy', isBusy);
}

function updateLaunchLabel() {
  $('play-label').textContent = busy ? 'Running...' : `Launch ${LOADER_META[currentLoader()].name}`;
}

function updateLoaderUI() {
  const meta = LOADER_META[currentLoader()];
  $('loader-name').textContent = meta.name;
  $('loader-sub').textContent = `${meta.sub} — click to change`;
  $('loader-hex').className = `hex hex-${meta.color}`;
  updateLaunchLabel();
}

function updateAvatars() {
  const initial = (($('username').value.trim())[0] || 'P').toUpperCase();
  $('rail-avatar').textContent = initial;
  $('chip-avatar').textContent = initial;
}

function currentLoader() {
  return $('loader').value;
}

function currentLoaderVersion() {
  return $('loader-version').value;
}

function filteredVersions(showSnapshots) {
  const types = showSnapshots ? null : ['release'];
  return allVersions.filter(v => !types || types.includes(v.type));
}

function renderPills(showSnapshots) {
  const wrap = $('version-pills');
  const frag = document.createDocumentFragment();
  for (const v of filteredVersions(showSnapshots)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.dataset.id = v.id;
    b.title = v.type;
    b.textContent = v.id;
    frag.appendChild(b);
  }
  wrap.replaceChildren(frag);
}

function markSel() {
  const wrap = $('version-pills');
  for (const el of wrap.children) el.classList.toggle('sel', el.dataset.id === selectedVersionId);
  const sel = wrap.querySelector('.pill.sel');
  if (sel) wrap.scrollTo({ left: sel.offsetLeft - wrap.clientWidth / 2 + sel.clientWidth / 2, behavior: 'smooth' });
}

function selectVersion(id, preferred) {
  selectedVersionId = id;
  markSel();
  setStatusIdle();
  populateLoaderVersions(preferred);
}

async function populateLoaderVersions(preferred) {
  const loader = currentLoader();
  const gameVersion = selectedVersionId;
  const sel = $('loader-version');
  const row = $('row-loader-version');
  const note = $('loader-note');
  const sub = $('loader-version-sub');

  if (loader === 'vanilla' || !gameVersion) {
    row.classList.add('off');
    note.classList.add('hidden');
    sub.textContent = loader === 'vanilla' ? 'Not used' : '—';
    sel.innerHTML = '';
    loaderVersions = [];
    return;
  }

  note.classList.add('hidden');
  sub.textContent = 'Loading...';

  const res = await api.getLoaderVersions({ loader, gameVersion });
  if (!res.ok || res.versions.length === 0) {
    row.classList.add('off');
    sel.innerHTML = '';
    loaderVersions = [];
    sub.textContent = 'Not available';
    note.classList.remove('hidden');
    note.textContent = res.ok
      ? `No ${loader} versions exist for ${gameVersion}.`
      : `Failed to load ${loader} versions: ${res.error}`;
    return;
  }

  loaderVersions = res.versions;
  sel.innerHTML = '';
  for (const v of res.versions.slice(0, 200)) {
    const opt = document.createElement('option');
    opt.value = v.version;
    opt.textContent = v.version + (v.recommended ? ' (recommended)' : '');
    sel.appendChild(opt);
  }

  // For Forge prefer the recommended build; otherwise newest.
  const recommended = res.versions.find(v => v.recommended);
  const defaultV = preferred && res.versions.some(v => v.version === preferred)
    ? preferred
    : (loader === 'forge' && recommended ? recommended.version : res.versions[0].version);
  sel.value = defaultV;

  row.classList.remove('off');
  sub.textContent = defaultV;
}

async function openInstanceFolder() {
  const dir = await api.openInstanceDir({
    versionId: selectedVersionId,
    loader: currentLoader(),
    loaderVersion: currentLoaderVersion(),
  });
  log(`[launcher] Instance folder: ${dir}`);
}

function switchTab(name) {
  for (const t of ['play', 'browse', 'ai', 'settings']) {
    $('tab-' + t).classList.toggle('active', t === name);
    $('page-' + t).classList.toggle('active', t === name);
  }
  if (name === 'browse') runSearch(false);
  if (name === 'ai') setTimeout(() => $('ai-input').focus(), 60);
}

/* ---------- Mod browser (Modrinth / CurseForge) ---------- */
function browseKey() {
  return `${browseSource}|${browseType}|${browseQuery}|${selectedVersionId}|${currentLoader()}`;
}

function emptyMsg(text) {
  const d = document.createElement('div');
  d.className = 'browse-empty';
  d.textContent = text;
  return d;
}

function iconPlaceholder(hit) {
  const ph = document.createElement('span');
  ph.className = 'mod-icon ph';
  ph.textContent = (hit.title || '?')[0].toUpperCase();
  return ph;
}

async function installMod(hit, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  const filesRes = await api.modFiles({ source: hit.source, projectId: hit.id, gameVersion: selectedVersionId, loader: currentLoader(), type: 'mod' });
  if (!filesRes.ok || !filesRes.files.length) {
    btn.textContent = 'No file';
    btn.title = `No ${currentLoader()} file for ${selectedVersionId}.`;
    return;
  }
  const f = filesRes.files[0];
  const res = await api.modInstall({
    fileUrl: f.fileUrl,
    filename: f.filename,
    versionId: selectedVersionId,
    loader: currentLoader(),
    loaderVersion: currentLoaderVersion(),
  });
  if (!res.ok) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    log(`[launcher] Mod install failed: ${res.error}`);
    return;
  }
  btn.classList.add('done');
  btn.textContent = res.existing ? 'Already in' : 'Added';
  log(`[launcher] ${hit.title} → ${res.dest}`);
}

function modCard(hit) {
  const card = document.createElement('div');
  card.className = 'mod-card';

  const head = document.createElement('div');
  head.className = 'mod-head';
  if (hit.iconUrl) {
    const img = document.createElement('img');
    img.className = 'mod-icon';
    img.src = hit.iconUrl;
    img.alt = '';
    img.onerror = () => img.replaceWith(iconPlaceholder(hit));
    head.appendChild(img);
  } else {
    head.appendChild(iconPlaceholder(hit));
  }
  const titles = document.createElement('div');
  titles.className = 'mod-titles';
  const t = document.createElement('div');
  t.className = 'mod-title';
  t.textContent = hit.title;
  t.title = hit.title;
  const a = document.createElement('div');
  a.className = 'mod-author';
  a.textContent = `by ${hit.author || 'unknown'}`;
  titles.append(t, a);
  head.appendChild(titles);
  card.appendChild(head);

  const desc = document.createElement('div');
  desc.className = 'mod-desc';
  desc.textContent = hit.description || '';
  card.appendChild(desc);

  const foot = document.createElement('div');
  foot.className = 'mod-foot';
  const dl = document.createElement('span');
  dl.className = 'mod-dl';
  dl.textContent = `${hit.downloadsLabel} downloads`;
  foot.appendChild(dl);
  const btn = document.createElement('button');
  btn.className = 'red-btn tiny';
  if (hit.type === 'modpack') {
    btn.textContent = 'Browse only';
    btn.disabled = true;
    btn.title = 'Modpack browsing is supported; one-click modpack installs are not in yet.';
  } else {
    btn.textContent = 'Add';
    btn.title = `Install into this instance's mods folder (${selectedVersionId} + ${currentLoader()})`;
    btn.addEventListener('click', () => installMod(hit, btn));
  }
  foot.appendChild(btn);
  card.appendChild(foot);
  return card;
}

async function runSearch(force) {
  const key = browseKey();
  const grid = $('mod-grid');
  if (!force && key === lastSearchKey && grid.children.length) return;
  lastSearchKey = key;
  $('browse-note').textContent = '';

  if (browseSource === 'curseforge' && !cfKey) {
    grid.innerHTML = '';
    grid.appendChild(emptyMsg('CurseForge browsing needs a free API key. Add it in Settings → CurseForge API key, then come back.'));
    $('browse-count').textContent = '';
    return;
  }

  $('browse-count').textContent = 'Searching...';
  grid.innerHTML = '';
  const res = await api.modSearch({
    source: browseSource,
    query: browseQuery,
    type: browseType,
    gameVersion: selectedVersionId,
    loader: currentLoader(),
  });
  if (!res.ok) {
    $('browse-count').textContent = '';
    grid.innerHTML = '';
    grid.appendChild(emptyMsg(res.error === 'no-key'
      ? 'CurseForge API key missing — set it in Settings.'
      : `Search failed: ${res.error}`));
    return;
  }
  const loaderLabel = currentLoader() === 'vanilla' ? '' : ` + ${currentLoader()}`;
  $('browse-count').textContent = `${res.total.toLocaleString()} results · ${selectedVersionId}${loaderLabel}`;
  grid.innerHTML = '';
  if (!res.hits.length) {
    grid.appendChild(emptyMsg('Nothing found. Try another search, version or loader.'));
    return;
  }
  for (const hit of res.hits) grid.appendChild(modCard(hit));
}

/* ---------- AI Helper (Gemini) ---------- */
const aiMsgs = $('ai-messages');
const aiInput = $('ai-input');
const aiSendBtn = $('ai-send');
let aiHistory = [];   // [{ role: 'user'|'model', text }]
let aiBusy = false;

const AI_WELCOME = '<div class="ai-welcome"><strong>Ask me anything.</strong>' +
  '<span>Minecraft help, mod troubleshooting, or any question at all. Add a free Gemini API key in Settings to start.</span></div>';

function updateAiBadge() {
  const model = ($('gemini-model').value || '').trim() || 'gemini-2.5-flash';
  const badge = $('ai-model-badge');
  badge.textContent = model;
  badge.title = geminiKey ? `API key set · ${model}` : 'No API key set — add one in Settings';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal, XSS-safe markdown: escape first, then inline code + bold. URLs stay
// plain text (the app has no window-open handler, so clickable links are avoided).
function formatAnswer(text) {
  let h = escapeHtml(text);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return h;
}

function clearWelcome() {
  const w = aiMsgs.querySelector('.ai-welcome');
  if (w) w.remove();
}

const AVATAR = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.3L18 9l-4.1 1.7L12 15l-1.9-4.3L6 9l4.1-1.7z"/></svg>',
};

function addMessage(role, html, isErr) {
  clearWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const av = document.createElement('span');
  av.className = 'msg-av';
  av.innerHTML = AVATAR[role];
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble' + (isErr ? ' err' : '');
  bubble.innerHTML = html;
  wrap.append(av, bubble);
  aiMsgs.appendChild(wrap);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  return bubble;
}

function addTyping() {
  clearWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = `<span class="msg-av">${AVATAR.bot}</span>` +
    '<div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
  aiMsgs.appendChild(wrap);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  return wrap;
}

function autoGrow() {
  aiInput.style.height = 'auto';
  aiInput.style.height = Math.min(aiInput.scrollHeight, 140) + 'px';
}

async function aiSend() {
  const text = aiInput.value.trim();
  if (!text || aiBusy) return;
  if (!geminiKey) {
    addMessage('bot', escapeHtml('No Gemini API key set. Open Settings, paste a free key from aistudio.google.com, then Save settings.'), true);
    switchTab('settings');
    return;
  }
  aiBusy = true;
  aiSendBtn.disabled = true;
  aiInput.value = '';
  autoGrow();
  addMessage('user', escapeHtml(text));
  const typing = addTyping();
  const res = await api.aiAsk({ question: text, history: aiHistory });
  typing.remove();
  if (res.ok) {
    aiHistory.push({ role: 'user', text }, { role: 'model', text: res.text });
    if (aiHistory.length > 12) aiHistory = aiHistory.slice(-12);
    addMessage('bot', formatAnswer(res.text));
  } else {
    const msg = res.error === 'no-key'
      ? 'No Gemini API key set. Add one in Settings.'
      : `AI Helper error: ${res.error}`;
    addMessage('bot', escapeHtml(msg), true);
  }
  aiBusy = false;
  aiSendBtn.disabled = false;
  aiInput.focus();
}

aiSendBtn.addEventListener('click', aiSend);
aiInput.addEventListener('input', autoGrow);
aiInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); }
});
$('ai-clear').addEventListener('click', () => {
  aiHistory = [];
  aiMsgs.innerHTML = AI_WELCOME;
});
$('gemini-key').addEventListener('change', () => {
  geminiKey = $('gemini-key').value.trim();
  api.saveSettings({ geminiKey });
  updateAiBadge();
});
$('gemini-model').addEventListener('change', () => {
  api.saveSettings({ geminiModel: $('gemini-model').value.trim() });
  updateAiBadge();
});

async function init() {
  const s = await api.getSettings();
  $('username').value = s.username || '';
  $('ram').value = s.ramMb;
  $('ram-label').textContent = (s.ramMb / 1024).toFixed(s.ramMb % 1024 ? 1 : 0) + ' GB';
  $('snapshots').checked = s.showSnapshots;
  $('snap-pill').classList.toggle('on', !!s.showSnapshots);
  $('gamedir').value = s.gameDir;
  $('javapath').value = s.javaPath || '';
  $('width').value = s.width || '';
  $('height').value = s.height || '';
  cfKey = s.curseforgeKey || '';
  $('curseforge-key').value = cfKey;
  geminiKey = s.geminiKey || '';
  $('gemini-key').value = geminiKey;
  $('gemini-model').value = s.geminiModel || '';
  updateAiBadge();
  if (s.loader) $('loader').value = s.loader;
  updateAvatars();
  updateLoaderUI();

  try {
    const data = await api.getVersions();
    allVersions = data.versions;
    renderPills(s.showSnapshots);
    const list = filteredVersions(s.showSnapshots);
    selectedVersionId = data.latest?.release && list.some(v => v.id === data.latest.release)
      ? data.latest.release
      : list[0]?.id || '';
    markSel();
    await populateLoaderVersions(s.loaderVersion);
  } catch (err) {
    log(`[launcher] Failed to load version list: ${err.message}`);
  }
  setStatusIdle();

  try {
    const javas = await api.getJavas();
    $('java-list').textContent = javas.length
      ? 'Detected: ' + javas.map(j => `Java ${j.major} (${j.path})`).join(', ')
      : 'No Java detected — the launcher will download one automatically.';
  } catch {}
}

$('tab-play').addEventListener('click', () => switchTab('play'));
$('tab-browse').addEventListener('click', () => switchTab('browse'));
$('tab-ai').addEventListener('click', () => switchTab('ai'));
$('tab-settings').addEventListener('click', () => switchTab('settings'));
$('goto-settings').addEventListener('click', () => switchTab('settings'));

for (const btn of document.querySelectorAll('#seg-source .seg-btn')) {
  btn.addEventListener('click', () => {
    if (browseSource === btn.dataset.source) return;
    browseSource = btn.dataset.source;
    for (const b of document.querySelectorAll('#seg-source .seg-btn')) b.classList.toggle('sel', b === btn);
    runSearch(true);
  });
}
for (const btn of document.querySelectorAll('#seg-type .seg-btn')) {
  btn.addEventListener('click', () => {
    if (browseType === btn.dataset.type) return;
    browseType = btn.dataset.type;
    for (const b of document.querySelectorAll('#seg-type .seg-btn')) b.classList.toggle('sel', b === btn);
    runSearch(true);
  });
}
$('mod-query').addEventListener('input', () => {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(() => {
    browseQuery = $('mod-query').value.trim();
    runSearch(true);
  }, 350);
});
$('mod-query').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  clearTimeout(browseTimer);
  browseQuery = $('mod-query').value.trim();
  runSearch(true);
});

$('curseforge-key').addEventListener('change', async () => {
  cfKey = $('curseforge-key').value.trim();
  await api.saveSettings({ curseforgeKey: cfKey });
  if (browseSource === 'curseforge') runSearch(true);
});

$('version-pills').addEventListener('click', e => {
  const btn = e.target.closest('.pill');
  if (btn && btn.dataset.id && btn.dataset.id !== selectedVersionId) selectVersion(btn.dataset.id);
});

$('snapshots').addEventListener('change', () => {
  const on = $('snapshots').checked;
  $('snap-pill').classList.toggle('on', on);
  renderPills(on);
  if (!$('version-pills').querySelector('.pill.sel')) {
    selectedVersionId = filteredVersions(on)[0]?.id || '';
  }
  markSel();
  setStatusIdle();
  populateLoaderVersions();
  api.saveSettings({ showSnapshots: on });
});

$('loader').addEventListener('change', () => {
  updateLoaderUI();
  api.saveSettings({ loader: currentLoader(), loaderVersion: '' });
  populateLoaderVersions();
  setStatusIdle();
});

$('loader-version').addEventListener('change', () => {
  $('loader-version-sub').textContent = currentLoaderVersion();
  api.saveSettings({ loaderVersion: currentLoaderVersion() });
});

$('ram').addEventListener('input', () => {
  const mb = Number($('ram').value);
  $('ram-label').textContent = (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB';
});

$('username').addEventListener('input', updateAvatars);
$('username').addEventListener('change', () => {
  updateAvatars();
  api.saveSettings({ username: $('username').value.trim() });
});

$('browse').addEventListener('click', async () => {
  const dir = await api.pickDirectory();
  if (dir) $('gamedir').value = dir;
});

$('save-settings').addEventListener('click', async () => {
  await api.saveSettings({
    gameDir: $('gamedir').value.trim(),
    javaPath: $('javapath').value.trim(),
    ramMb: Number($('ram').value),
    username: $('username').value.trim(),
    width: Number($('width').value) || 0,
    height: Number($('height').value) || 0,
    curseforgeKey: $('curseforge-key').value.trim(),
    geminiKey: $('gemini-key').value.trim(),
    geminiModel: $('gemini-model').value.trim(),
  });
  cfKey = $('curseforge-key').value.trim();
  geminiKey = $('gemini-key').value.trim();
  updateAiBadge();
  $('save-status').classList.remove('hidden');
  setTimeout(() => $('save-status').classList.add('hidden'), 2000);
});

async function checkForUpdates(silent) {
  const status = $('update-status');
  const btn = $('check-updates');
  if (!silent) {
    btn.disabled = true;
    status.classList.remove('hidden');
    status.textContent = 'Checking for updates...';
  }
  try {
    const res = await api.checkForUpdates();
    const msg = res.message || (res.ok ? 'Up to date.' : 'Update check failed.');
    if (!silent) {
      status.textContent = msg;
      if (res.state === 'updated') {
        btn.textContent = 'Restart to update';
        btn.disabled = false;
        btn.dataset.restart = '1';
        return;
      }
      setTimeout(() => status.classList.add('hidden'), 4000);
    } else if (res.state === 'updated') {
      log(`[launcher] ${msg}`);
      status.classList.remove('hidden');
      status.textContent = msg;
      btn.textContent = 'Restart to update';
      btn.dataset.restart = '1';
    }
  } catch (err) {
    if (!silent) {
      status.textContent = 'Update check failed: ' + err.message;
      setTimeout(() => status.classList.add('hidden'), 4000);
    }
  } finally {
    if (!silent && btn.dataset.restart !== '1') btn.disabled = false;
  }
}

$('check-updates').addEventListener('click', () => {
  if ($('check-updates').dataset.restart === '1') { api.restartApp(); return; }
  checkForUpdates(false);
});

api.onUpdateDownloaded(info => {
  log(`[launcher] Update ${info.version} ready — restart to install.`);
  const status = $('update-status');
  const btn = $('check-updates');
  status.classList.remove('hidden');
  status.textContent = `Version ${info.version} downloaded. Restart to install.`;
  btn.textContent = 'Restart to update';
  btn.disabled = false;
  btn.dataset.restart = '1';
});

$('open-folder').addEventListener('click', openInstanceFolder);
$('row-folder').addEventListener('click', openInstanceFolder);

$('clear-log').addEventListener('click', clearLog);

let lastAutoRefresh = 0;
async function refreshVersions(silent) {
  if (busy) return;
  lastAutoRefresh = Date.now();
  if (!silent) log('[launcher] Refreshing version list...');
  try {
    const data = await api.getVersions();
    allVersions = data.versions;
    renderPills($('snapshots').checked);
    if (!allVersions.some(v => v.id === selectedVersionId)) {
      const list = filteredVersions($('snapshots').checked);
      selectedVersionId = data.latest?.release && list.some(v => v.id === data.latest.release)
        ? data.latest.release
        : list[0]?.id || '';
      populateLoaderVersions();
    }
    markSel();
    setStatusIdle();
    if (!silent) log('[launcher] Version list refreshed.');
  } catch (err) {
    if (!silent) log(`[launcher] Refresh failed: ${err.message}`);
  }
}

$('refresh-versions').addEventListener('click', () => refreshVersions(false));

// Keep the version list current: refresh every 15 minutes and whenever the
// window regains focus, so newly released Minecraft versions appear automatically.
setInterval(() => refreshVersions(true), 15 * 60 * 1000);
window.addEventListener('focus', () => {
  // Avoid a fetch + full pill rebuild on every alt-tab back to the window.
  if (Date.now() - lastAutoRefresh < 120000) return;
  refreshVersions(true);
});

$('play').addEventListener('click', async () => {
  if (busy) return;
  const username = $('username').value.trim() || 'Player';
  const versionId = selectedVersionId;
  const version = allVersions.find(v => v.id === versionId);
  if (!version) { log('[launcher] No version selected.'); return; }

  const loader = currentLoader();
  const loaderVersion = currentLoaderVersion();
  if (loader !== 'vanilla' && !loaderVersion) {
    log(`[launcher] No ${loader} version available for ${versionId}.`);
    return;
  }

  await api.saveSettings({
    ramMb: Number($('ram').value),
    username,
    loader,
    loaderVersion,
  });

  setBusy(true);
  $('progress-fill').style.width = '0%';
  $('progress-text').textContent = 'Starting...';
  setStatus('Launching', `${versionId} as ${username}`);
  log(`[launcher] Launching ${versionId}${loader === 'vanilla' ? '' : ' + ' + loader + ' ' + loaderVersion} as ${username}...`);

  const res = await api.launch({ versionId, versionUrl: version.url, username, loader, loaderVersion });
  if (!res.ok) {
    setBusy(false);
    log(`[launcher] Launch failed: ${res.error}`);
    $('progress-text').textContent = 'Failed: ' + res.error;
    setStatus('Launch failed', res.error);
  }
});

// Progress events fire very fast during parallel downloads; coalesce to one
// DOM write per frame instead of thrashing layout on every event.
let progPending = null;
let progRaf = 0;
function renderProgress() {
  progRaf = 0;
  const p = progPending;
  if (!p || !busy) return;
  const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  const label = PHASE_LABEL[p.phase] || p.phase;
  const detail = p.file ? ` — ${p.file}` : '';
  $('progress-text').textContent = `${label}: ${p.current}/${p.total} (${pct}%)${detail}`;
  setStatus(label, `${p.current}/${p.total}${p.file ? ' · ' + p.file : ''}`);
  if (p.phase === 'java') log(`[launcher] ${p.file}`);
}
api.onProgress(p => {
  if (!busy) return;
  progPending = p;
  if (!progRaf) progRaf = requestAnimationFrame(renderProgress);
});

api.onGameLog(line => log(line.replace(/\n$/, '')));

api.onGameExit(info => {
  setBusy(false);
  $('progress-fill').style.width = '100%';
  if (info.error) log(`[launcher] Game process error: ${info.error}`);
  else log(`[launcher] Game exited (code ${info.code}${info.signal ? ', ' + info.signal : ''}).`);
  $('progress-text').textContent = info.code === 0 ? 'Game closed.' : `Game exited with code ${info.code}.`;
  setStatus('Game closed', info.code === 0 ? 'See you next time' : `exit code ${info.code}`);
});

// Pointer ripple on press. Delegated so dynamically created pills get it too.
// Uses only transform/opacity so it stays on the compositor (no layout/paint jank).
const RIPPLE_SEL = '.launch-btn,.red-btn,.pill,.rail-btn,.circle-btn,.mini-btn,.seg-btn,.snap-pill';
document.addEventListener('pointerdown', e => {
  const host = e.target.closest(RIPPLE_SEL);
  if (!host || host.disabled) return;
  const rect = host.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ink = document.createElement('span');
  ink.className = 'ripple-ink';
  ink.style.width = ink.style.height = size + 'px';
  ink.style.left = (e.clientX - rect.left - size / 2) + 'px';
  ink.style.top = (e.clientY - rect.top - size / 2) + 'px';
  host.appendChild(ink);
  ink.addEventListener('animationend', () => ink.remove(), { once: true });
}, { passive: true });

init();

// Silently check GitHub for launcher updates shortly after startup, then hourly.
setTimeout(() => checkForUpdates(true), 4000);
setInterval(() => checkForUpdates(true), 60 * 60 * 1000);
