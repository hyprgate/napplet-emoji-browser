import { describe, expect, it } from 'vitest';
import type { EmojiBrowserItem } from './emoji-browser-store.js';
import {
  ACTIVE_EMOJI_RESOLVER_LIMIT,
  countTimedOutEmojiItems,
  countUnresolvedEmojiItems,
  resolvedEmojiItems,
  retryTimedOutEmojiResolutions,
  selectActiveEmojiResolutionItems,
  setEmojiResolution,
  setEmojiResolutionForSource,
  syncEmojiResolutions,
  type EmojiResolutionMap,
} from './emoji-resolution.js';

function item(key: string, shortcode = key): EmojiBrowserItem {
  return {
    key,
    shortcode,
    imageUrl: `https://emoji.example/${shortcode}.png`,
    authorPubkey: 'a'.repeat(64),
    eventId: 'event-id',
    eventKind: 30030,
    createdAt: 100,
    sourceTitle: 'Emoji set',
    tag: ['emoji', shortcode, `https://emoji.example/${shortcode}.png`],
    added: false,
  };
}

describe('emoji resolution helpers', () => {
  it('initializes new emoji as unresolved and removes stale entries', () => {
    const current: EmojiResolutionMap = {
      old: { status: 'resolved', attempt: 0 },
      ready: { status: 'resolved', attempt: 2 },
    };

    expect(syncEmojiResolutions([item('ready'), item('slow')], current)).toEqual({
      ready: { status: 'resolved', attempt: 2 },
      slow: { status: 'pending', attempt: 0 },
    });
  });

  it('only returns emoji whose images have resolved while still counting unresolved loaded events', () => {
    const items = [item('ready'), item('pending'), item('timeout')];
    const resolutions: EmojiResolutionMap = {
      ready: { status: 'resolved', attempt: 0 },
      pending: { status: 'pending', attempt: 0 },
      timeout: { status: 'timed-out', attempt: 0 },
    };

    expect(resolvedEmojiItems(items, resolutions).map((emoji) => emoji.key)).toEqual(['ready']);
    expect(countUnresolvedEmojiItems(items, resolutions)).toBe(2);
    expect(countTimedOutEmojiItems(items, resolutions)).toBe(1);
  });

  it('counts entries with no resolution state as unresolved', () => {
    const items = [item('missing')];

    expect(countUnresolvedEmojiItems(items, {})).toBe(1);
    expect(resolvedEmojiItems(items, {}).map((emoji) => emoji.key)).toEqual([]);
  });

  it('creates missing resolution entries when the image action reports a result first', () => {
    expect(setEmojiResolution({}, 'ready', 'resolved')).toEqual({
      ready: { status: 'resolved', attempt: 0 },
    });
  });

  it('retries every timed-out emoji once while preserving other resolution states', () => {
    const retried = retryTimedOutEmojiResolutions({
      ready: { status: 'resolved', attempt: 0 },
      slow: { status: 'timed-out', attempt: 0 },
      stale: { status: 'timed-out', attempt: 2 },
      pending: { status: 'pending', attempt: 1 },
    });

    expect(retried).toEqual({
      ready: { status: 'resolved', attempt: 0 },
      slow: { status: 'pending', attempt: 1 },
      stale: { status: 'pending', attempt: 3 },
      pending: { status: 'pending', attempt: 1 },
    });
  });

  it('limits active image resolvers so large emoji lists cannot mount every hidden resolver at once', () => {
    const items = Array.from({ length: ACTIVE_EMOJI_RESOLVER_LIMIT + 25 }, (_, index) =>
      item(`emoji-${index}`),
    );

    expect(selectActiveEmojiResolutionItems(items, items, {}, ACTIVE_EMOJI_RESOLVER_LIMIT))
      .toHaveLength(ACTIVE_EMOJI_RESOLVER_LIMIT);
  });

  it('coalesces duplicate image URLs into one active resolver', () => {
    const first = item('first', 'shared');
    const duplicate = { ...item('duplicate', 'shared'), imageUrl: first.imageUrl };
    const other = item('other');

    expect(selectActiveEmojiResolutionItems([first, duplicate, other], [first, duplicate, other], {}, 8)
      .map((emoji) => emoji.key))
      .toEqual(['first', 'other']);
  });

  it('marks duplicate image URLs resolved after one resource result', () => {
    const first = item('first', 'shared');
    const duplicate = { ...item('duplicate', 'shared'), imageUrl: first.imageUrl };

    expect(setEmojiResolutionForSource([first, duplicate], {}, first.imageUrl, 'resolved')).toEqual({
      first: { status: 'resolved', attempt: 0 },
      duplicate: { status: 'resolved', attempt: 0 },
    });
  });

  it('prioritizes filtered unresolved emoji before background resolution work', () => {
    const all = Array.from({ length: 8 }, (_, index) => item(`emoji-${index}`));
    const filtered = [all[6]!, all[2]!, all[3]!];
    const resolutions: EmojiResolutionMap = {
      'emoji-0': { status: 'pending', attempt: 0 },
      'emoji-1': { status: 'resolved', attempt: 0 },
      'emoji-2': { status: 'pending', attempt: 0 },
      'emoji-3': { status: 'timed-out', attempt: 0 },
      'emoji-4': { status: 'pending', attempt: 0 },
      'emoji-5': { status: 'pending', attempt: 0 },
      'emoji-6': { status: 'pending', attempt: 0 },
      'emoji-7': { status: 'pending', attempt: 0 },
    };

    expect(selectActiveEmojiResolutionItems(filtered, all, resolutions, 4).map((emoji) => emoji.key))
      .toEqual(['emoji-6', 'emoji-2', 'emoji-0', 'emoji-4']);
  });

  it('uses stored resolved-source hints before low-priority background work', () => {
    const all = Array.from({ length: 6 }, (_, index) => item(`emoji-${index}`));
    const filtered = [all[5]!];

    expect(selectActiveEmojiResolutionItems(filtered, all, {}, 3, [all[3]!.imageUrl, all[1]!.imageUrl])
      .map((emoji) => emoji.key))
      .toEqual(['emoji-5', 'emoji-1', 'emoji-3']);
  });
});
