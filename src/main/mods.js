const MODRINTH = 'https://api.modrinth.com/v2';
const CURSEFORGE = 'https://api.curseforge.com/v1';

// CurseForge loader enum for mods/search
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5 };

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function fmtCount(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function modrinthSearch({ query, type, gameVersion, loader, limit = 24, offset = 0 }) {
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader && loader !== 'vanilla') facets.push([`categories:${loader}`]);
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), facets: JSON.stringify(facets) });
  if (query) params.set('query', query);
  const data = await fetchJson(`${MODRINTH}/search?${params}`);
  return {
    ok: true,
    source: 'modrinth',
    total: data.total_hits || 0,
    hits: (data.hits || []).map(h => ({
      source: 'modrinth',
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      author: h.author,
      description: h.description,
      iconUrl: h.icon_url || '',
      downloads: h.downloads || 0,
      downloadsLabel: fmtCount(h.downloads),
      categories: h.categories || [],
      type,
    })),
  };
}

async function modrinthFiles({ projectId, gameVersion, loader, type }) {
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (type === 'mod' && loader && loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]));
  const list = await fetchJson(`${MODRINTH}/project/${projectId}/version?${params}`);
  return (Array.isArray(list) ? list : []).map(v => {
    const file = v.files?.find(f => f.primary) || v.files?.[0];
    return {
      id: v.id,
      name: v.version_number || v.name,
      filename: file?.url ? decodeURIComponent(file.url.split('/').pop()) : `${projectId}-${v.id}.jar`,
      fileUrl: file?.url || '',
      gameVersions: v.game_versions || [],
    };
  }).filter(f => f.fileUrl);
}

async function curseforgeSearch({ apiKey, query, type, gameVersion, loader, limit = 24, offset = 0 }) {
  if (!apiKey) return { ok: false, error: 'no-key' };
  const params = new URLSearchParams({
    gameId: '432',
    classId: type === 'modpack' ? '4471' : '6',
    sortField: '2',
    sortOrder: 'desc',
    pageSize: String(limit),
    index: String(offset),
  });
  if (query) params.set('searchFilter', query);
  if (gameVersion) params.set('gameVersion', gameVersion);
  if (type === 'mod' && CF_LOADER[loader]) params.set('modLoaderType', String(CF_LOADER[loader]));
  const data = await fetchJson(`${CURSEFORGE}/mods/search?${params}`, { 'x-api-key': apiKey, accept: 'application/json' });
  return {
    ok: true,
    source: 'curseforge',
    total: data.pagination?.totalCount || 0,
    hits: (data.data || []).map(m => ({
      source: 'curseforge',
      id: m.id,
      slug: m.slug,
      title: m.name,
      author: (m.authors || []).map(a => a.name).join(', '),
      description: (m.summary || '').replace(/<[^>]+>/g, ''),
      iconUrl: m.logo?.thumbnailUrl || m.logo?.url || '',
      downloads: m.downloadCount || 0,
      downloadsLabel: fmtCount(m.downloadCount),
      categories: (m.categories || []).map(c => c.name),
      type,
    })),
  };
}

async function curseforgeFiles({ apiKey, modId, gameVersion, loader }) {
  if (!apiKey) return [];
  const build = withLoader => {
    const params = new URLSearchParams({ pageSize: '50' });
    if (gameVersion) params.set('gameVersion', gameVersion);
    if (withLoader && CF_LOADER[loader]) params.set('modLoaderType', String(CF_LOADER[loader]));
    return `${CURSEFORGE}/mods/${modId}/files?${params}`;
  };
  const mapFiles = data => (data.data || [])
    .filter(f => f.downloadUrl && !f.isAlternate)
    .map(f => ({
      id: f.id,
      name: f.displayName || f.fileName,
      filename: f.fileName,
      fileUrl: f.downloadUrl,
      gameVersions: f.gameVersions || [],
    }));
  const headers = { 'x-api-key': apiKey, accept: 'application/json' };
  // Filter to the selected loader so we never drop a Forge-only jar into a
  // Fabric/Quilt instance. Fall back to unfiltered when the loader tag yields
  // nothing (universal jars are sometimes untagged).
  if (CF_LOADER[loader]) {
    const filtered = mapFiles(await fetchJson(build(true), headers));
    if (filtered.length) return filtered;
  }
  return mapFiles(await fetchJson(build(false), headers));
}

async function search(opts) {
  return opts.source === 'curseforge' ? curseforgeSearch(opts) : modrinthSearch(opts);
}

async function files(opts) {
  return opts.source === 'curseforge'
    ? curseforgeFiles({ apiKey: opts.apiKey, modId: opts.projectId, gameVersion: opts.gameVersion, loader: opts.loader })
    : modrinthFiles(opts);
}

module.exports = { search, files };
