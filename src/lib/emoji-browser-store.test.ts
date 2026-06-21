import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@hyprgate/types';
import { KIND_EMOJI_SET, KIND_USER_EMOJI_LIST } from '@hyprgate/utils/emoji-sets';
import {
  buildCollectionTags,
  itemsFromEvent,
  normalizeFollowPubkeys,
  type EmojiBrowserItem,
} from './emoji-browser-store.js';

const PUBKEY = 'a'.repeat(64);

function event(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'event-id',
    kind: KIND_EMOJI_SET,
    pubkey: PUBKEY,
    created_at: 100,
    tags: [],
    content: '',
    sig: 'sig',
    ...overrides,
  };
}

describe('emoji browser helpers', () => {
  it('extracts custom emoji from NIP-30 tags on kind 30030 sets', () => {
    expect(itemsFromEvent(event({
      tags: [
        ['d', 'cats'],
        ['title', 'Cats'],
        ['emoji', 'blobcat', 'https://emoji.example/blobcat.png'],
        ['emoji', '😀'],
      ],
    }))).toEqual([
      {
        key: `blobcat\nhttps://emoji.example/blobcat.png\n${KIND_EMOJI_SET}:${PUBKEY}:cats\n${PUBKEY}`,
        shortcode: 'blobcat',
        imageUrl: 'https://emoji.example/blobcat.png',
        address: `${KIND_EMOJI_SET}:${PUBKEY}:cats`,
        authorPubkey: PUBKEY,
        eventId: 'event-id',
        eventKind: KIND_EMOJI_SET,
        createdAt: 100,
        sourceTitle: 'Cats',
        tag: ['emoji', 'blobcat', 'https://emoji.example/blobcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        added: false,
      },
    ]);
  });

  it('marks items already present in the user collection', () => {
    const collectionTags = [['emoji', 'blobcat', 'https://emoji.example/blobcat.png']];
    expect(itemsFromEvent(event({
      kind: KIND_USER_EMOJI_LIST,
      tags: [['emoji', 'blobcat', 'https://emoji.example/blobcat.png']],
    }), collectionTags)[0]?.added).toBe(true);
  });

  it('appends a selected custom emoji while preserving existing list tags', () => {
    const item: EmojiBrowserItem = {
      key: 'k',
      shortcode: 'blobcat',
      imageUrl: 'https://emoji.example/blobcat.png',
      address: `${KIND_EMOJI_SET}:${PUBKEY}:cats`,
      authorPubkey: PUBKEY,
      eventId: 'set',
      eventKind: KIND_EMOJI_SET,
      createdAt: 100,
      sourceTitle: 'Cats',
      tag: ['emoji', 'blobcat', 'https://emoji.example/blobcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
      added: false,
    };

    const existing = event({
      kind: KIND_USER_EMOJI_LIST,
      tags: [['emoji', '😀'], ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`]],
    });

    expect(buildCollectionTags(existing, item)).toEqual([
      ['emoji', '😀'],
      ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
      ['emoji', 'blobcat', 'https://emoji.example/blobcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
    ]);
    expect(buildCollectionTags({ ...existing, tags: [...existing.tags, item.tag] }, item)).toEqual([
      ['emoji', '😀'],
      ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
      ['emoji', 'blobcat', 'https://emoji.example/blobcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
    ]);
  });

  it('normalizes missing follow lists before relay filtering', () => {
    expect(normalizeFollowPubkeys(undefined)).toEqual([]);
    expect(normalizeFollowPubkeys(['a', '', 'a', 42, 'b'])).toEqual(['a', 'b']);
  });
});
