import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@hyprgate/types';
import { KIND_EMOJI_SET, KIND_USER_EMOJI_LIST } from '@hyprgate/utils/emoji-sets';
import {
  buildCollectionTags,
  createEmojiBrowserStore,
  itemsFromEvent,
  latestUserEmojiListEvent,
  normalizeFollowPubkeys,
  type EmojiBrowserItem,
} from './emoji-browser-store.js';
import { identity, relay } from '@napplet/sdk';

vi.mock('@napplet/sdk', () => ({
  identity: {
    getPublicKey: vi.fn(),
    getFollows: vi.fn(),
  },
  outbox: {
    subscribe: vi.fn(),
  },
  relay: {
    query: vi.fn(),
    subscribe: vi.fn(),
    publish: vi.fn(),
  },
}));

const PUBKEY = 'a'.repeat(64);
const FOLLOW = 'b'.repeat(64);

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(identity.getPublicKey).mockResolvedValue(PUBKEY);
    vi.mocked(identity.getFollows).mockResolvedValue([FOLLOW]);
    vi.mocked(relay.query).mockResolvedValue([]);
    vi.mocked(relay.subscribe).mockReturnValue({ close: vi.fn() });
    vi.mocked(relay.publish).mockResolvedValue(event({ kind: KIND_USER_EMOJI_LIST, pubkey: PUBKEY }));
  });

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

  it('normalizes missing collection query results before event filtering', () => {
    expect(latestUserEmojiListEvent(undefined, PUBKEY)).toBeNull();
    expect(latestUserEmojiListEvent([
      event({ kind: KIND_USER_EMOJI_LIST, created_at: 100 }),
      event({ kind: KIND_EMOJI_SET, created_at: 300 }),
      event({ kind: KIND_USER_EMOJI_LIST, created_at: 200 }),
      event({ kind: KIND_USER_EMOJI_LIST, pubkey: 'b'.repeat(64), created_at: 400 }),
    ], PUBKEY)?.created_at).toBe(200);
  });

  it('refreshes the latest preferred list before publishing a custom emoji', async () => {
    const baseline = event({
      id: 'baseline',
      kind: KIND_USER_EMOJI_LIST,
      pubkey: PUBKEY,
      created_at: 200,
      tags: [
        ['emoji', '😀'],
        ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['emoji', 'oldcat', 'https://emoji.example/oldcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
      ],
    });
    vi.mocked(relay.query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([baseline]);

    let onEvent: ((event: NostrEvent) => void) | null = null;
    let onEose: (() => void) | null = null;
    vi.mocked(relay.subscribe).mockImplementation((_filter, eventCallback, eoseCallback) => {
      onEvent = eventCallback as (event: NostrEvent) => void;
      onEose = eoseCallback as () => void;
      return { close: vi.fn() };
    });

    const store = createEmojiBrowserStore();
    store.load();
    await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());

    onEvent!(event({
      kind: KIND_EMOJI_SET,
      pubkey: FOLLOW,
      created_at: 300,
      tags: [['d', 'dogs'], ['emoji', 'doge', 'https://emoji.example/doge.png']],
    }));
    onEose!();

    const item = store.state.items.find((candidate) => candidate.shortcode === 'doge')!;
    await store.addToCollection(item);

    expect(relay.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: KIND_USER_EMOJI_LIST,
      tags: [
        ['emoji', '😀'],
        ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['emoji', 'oldcat', 'https://emoji.example/oldcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['emoji', 'doge', 'https://emoji.example/doge.png', `${KIND_EMOJI_SET}:${FOLLOW}:dogs`],
      ],
    }));
  });
});
