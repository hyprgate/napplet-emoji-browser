import { describe, expect, it } from 'vitest';
import type { EmojiBrowserItem } from './emoji-browser-store.js';
import {
  countTimedOutEmojiItems,
  countUnresolvedEmojiItems,
  resolvedEmojiItems,
  retryTimedOutEmojiResolutions,
  setEmojiResolution,
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

  it('keeps loaded emoji visible even when image resolution is still pending or timed out', () => {
    const items = [item('ready'), item('pending'), item('timeout')];
    const resolutions: EmojiResolutionMap = {
      ready: { status: 'resolved', attempt: 0 },
      pending: { status: 'pending', attempt: 0 },
      timeout: { status: 'timed-out', attempt: 0 },
    };

    expect(resolvedEmojiItems(items, resolutions).map((emoji) => emoji.key)).toEqual(['ready', 'pending', 'timeout']);
    expect(countUnresolvedEmojiItems(items, resolutions)).toBe(2);
    expect(countTimedOutEmojiItems(items, resolutions)).toBe(1);
  });

  it('counts entries with no resolution state as unresolved', () => {
    const items = [item('missing')];

    expect(countUnresolvedEmojiItems(items, {})).toBe(1);
    expect(resolvedEmojiItems(items, {}).map((emoji) => emoji.key)).toEqual(['missing']);
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
});
