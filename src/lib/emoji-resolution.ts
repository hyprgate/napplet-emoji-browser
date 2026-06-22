import type { EmojiBrowserItem } from './emoji-browser-store.js';

export const EMOJI_RESOLVE_TIMEOUT_MS = 5_000;
export const ACTIVE_EMOJI_RESOLVER_LIMIT = 48;

export type EmojiResolveStatus = 'pending' | 'resolved' | 'timed-out';

export interface EmojiResolution {
  status: EmojiResolveStatus;
  attempt: number;
}

export type EmojiResolutionMap = Record<string, EmojiResolution>;

export function syncEmojiResolutions(
  items: readonly Pick<EmojiBrowserItem, 'key'>[],
  current: EmojiResolutionMap,
): EmojiResolutionMap {
  const itemKeys = new Set(items.map((item) => item.key));
  const next = { ...current };
  let changed = false;
  for (const item of items) {
    if (next[item.key]) continue;
    next[item.key] = { status: 'pending', attempt: 0 };
    changed = true;
  }
  for (const key of Object.keys(next)) {
    if (itemKeys.has(key)) continue;
    delete next[key];
    changed = true;
  }
  return changed ? next : current;
}

export function setEmojiResolution(
  current: EmojiResolutionMap,
  key: string,
  status: EmojiResolveStatus,
): EmojiResolutionMap {
  const previous = current[key] ?? { status: 'pending', attempt: 0 };
  if (previous.status === status) return current;
  return {
    ...current,
    [key]: { ...previous, status },
  };
}

export function retryTimedOutEmojiResolutions(current: EmojiResolutionMap): EmojiResolutionMap {
  const next = { ...current };
  let changed = false;
  for (const [key, value] of Object.entries(next)) {
    if (value.status !== 'timed-out') continue;
    next[key] = { status: 'pending', attempt: value.attempt + 1 };
    changed = true;
  }
  return changed ? next : current;
}

export function resolvedEmojiItems<T extends Pick<EmojiBrowserItem, 'key'>>(
  items: readonly T[],
  resolutions: EmojiResolutionMap,
): T[] {
  return items.filter((item) => resolutions[item.key]?.status === 'resolved');
}

export function selectActiveEmojiResolutionItems<T extends Pick<EmojiBrowserItem, 'key'>>(
  priorityItems: readonly T[],
  allItems: readonly T[],
  resolutions: EmojiResolutionMap,
  limit = ACTIVE_EMOJI_RESOLVER_LIMIT,
): T[] {
  const selected: T[] = [];
  const seen = new Set<string>();
  const max = Math.max(0, Math.floor(limit));

  function canResolve(item: T): boolean {
    if (seen.has(item.key)) return false;
    const status = resolutions[item.key]?.status;
    return status === undefined || status === 'pending';
  }

  function append(items: readonly T[]): void {
    for (const item of items) {
      if (selected.length >= max) return;
      if (!canResolve(item)) continue;
      seen.add(item.key);
      selected.push(item);
    }
  }

  append(priorityItems);
  append(allItems);
  return selected;
}

export function countUnresolvedEmojiItems(
  items: readonly Pick<EmojiBrowserItem, 'key'>[],
  resolutions: EmojiResolutionMap,
): number {
  return items.filter((item) => resolutions[item.key]?.status !== 'resolved').length;
}

export function countTimedOutEmojiItems(
  items: readonly Pick<EmojiBrowserItem, 'key'>[],
  resolutions: EmojiResolutionMap,
): number {
  return items.filter((item) => resolutions[item.key]?.status === 'timed-out').length;
}
