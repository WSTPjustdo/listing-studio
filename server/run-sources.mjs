import { clone, sourceIdsForProfile } from './domain.mjs';

// A current rule pack supplies its own authoritative source text. Stored product
// sources are added only when this product references them; other markets stay
// outside this request. The caller snapshots the result with the new version.
export function sourcesForRun(pack, recordedSources = [], product = null) {
  const current = new Map(pack.sources.map(source => [source.source_id, source]));
  const productSources = new Set(sourceIdsForProfile(product));
  for (const source of recordedSources)
    if (productSources.has(source.source_id) && !current.has(source.source_id))
      current.set(source.source_id, source);
  return clone([...current.values()]);
}
