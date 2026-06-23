export const SOURCE_METADATA_KEY = 'multi_chat_lore_sources';

export function normalizeSourceName(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function normalizeSourceList(values) {
  const sourceValues = Array.isArray(values) ? values : [];
  const seen = new Set();
  const result = [];

  for (const value of sourceValues) {
    const name = normalizeSourceName(value);
    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);
    result.push(name);
  }

  return result;
}

export function readSourceState(metadata) {
  const raw = metadata?.[SOURCE_METADATA_KEY];
  const updatedAt = Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : 0;

  return {
    version: 1,
    sources: normalizeSourceList(raw?.sources),
    updatedAt,
  };
}

export function setSourceState(metadata, sources, now = Date.now()) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('metadata object is required');
  }

  const normalized = normalizeSourceList(sources);

  if (!normalized.length) {
    clearSourceState(metadata);
    return [];
  }

  metadata[SOURCE_METADATA_KEY] = {
    version: 1,
    sources: normalized,
    updatedAt: now,
  };

  return normalized;
}

export function clearSourceState(metadata) {
  if (metadata && typeof metadata === 'object') {
    delete metadata[SOURCE_METADATA_KEY];
  }
}

export function buildInjectedSelection(snapshot, sources, excludedSources = []) {
  const excluded = new Set(normalizeSourceList(excludedSources));
  const sourceNames = normalizeSourceList(sources).filter((name) => !excluded.has(name));

  return normalizeSourceList([
    ...(Array.isArray(snapshot) ? snapshot : []),
    ...sourceNames,
  ]);
}

export function replaceArrayContents(target, values) {
  target.length = 0;
  target.push(...values);
}
