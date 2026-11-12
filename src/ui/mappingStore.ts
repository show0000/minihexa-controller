/** Mapping persistence: localStorage (every access guarded) and JSON file export/import. */
import { DEFAULT_ACTION_IDS, parseMapping, serializeMapping, type Mapping } from '../input/mapping';

export const MAPPING_KEY = 'minihexa.mapping.v1';

export function emptyMapping(): Mapping {
  return { version: 1, bindings: {}, actionIds: { ...DEFAULT_ACTION_IDS } };
}

/** Stored mapping, or null if there is none, it is unreadable, or storage is blocked. */
export function loadMapping(): Mapping | null {
  try {
    const raw = localStorage.getItem(MAPPING_KEY);
    return raw === null ? null : parseMapping(raw);
  } catch {
    return null;
  }
}

/** False if the browser refused to store it (private mode, quota, blocked storage). */
export function saveMapping(m: Mapping): boolean {
  try {
    localStorage.setItem(MAPPING_KEY, serializeMapping(m));
    return true;
  } catch {
    return false;
  }
}

export function downloadMapping(m: Mapping): void {
  const blob = new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'minihexa-mapping.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readMappingFile(file: File): Promise<Mapping> {
  return parseMapping(await file.text());
}
