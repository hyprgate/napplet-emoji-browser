import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@hyprgate/types';
import { KIND_EMOJI_SET, KIND_USER_EMOJI_LIST } from '@hyprgate/utils/emoji-sets';
import {
  buildCollectionTags,
  createEmojiBrowserStore,
  discoveryAuthors,
  groupEmojiItems,
  itemsFromEvent,
  latestUserEmojiListEvent,
  normalizeFollowPubkeys,
  parseEmojiBrowserPrefs,
  serializeEmojiBrowserPrefs,
  type EmojiBrowserItem,
} from './emoji-browser-store.js';
import { identity, outbox, relay } from '@napplet/sdk';

vi.mock('@napplet/sdk', () => ({
  identity: {
    getPublicKey: vi.fn(),
    getFollows: vi.fn(),
  },
  outbox: {
    subscribe: vi.fn(),
    query: vi.fn(),
  },
  relay: {
    query: vi.fn(),
    subscribe: vi.fn(),
    publish: vi.fn(),
  },
}));

function emojiItem(overrides: Partial<EmojiBrowserItem> & Pick<EmojiBrowserItem, 'shortcode'>): EmojiBrowserItem {
  return {
    key: `${overrides.shortcode}-key`,
    imageUrl: `https://emoji.example/${overrides.shortcode}.png`,
    authorPubkey: PUBKEY,
    eventId: 'evt',
    eventKind: KIND_EMOJI_SET,
    createdAt: 100,
    sourceTitle: 'Set',
    tag: ['emoji', overrides.shortcode, `https://emoji.example/${overrides.shortcode}.png`],
    added: false,
    ...overrides,
  };
}

const PUBKEY = 'a'.repeat(64);
const FOLLOW = 'b'.repeat(64);
type RelayEventResult = { event: NostrEvent };

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
    vi.mocked(outbox.query).mockResolvedValue({ events: [] });
    vi.mocked(outbox.subscribe).mockReturnValue({ on: vi.fn(), close: vi.fn() });
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
      .mockResolvedValueOnce([{ event: baseline }]);

    let onEvent: ((result: RelayEventResult) => void) | null = null;
    let onEose: (() => void) | null = null;
    vi.mocked(relay.subscribe).mockImplementation((_filter, eventCallback, eoseCallback) => {
      onEvent = eventCallback as (result: RelayEventResult) => void;
      onEose = eoseCallback as () => void;
      return { close: vi.fn() };
    });

    const store = createEmojiBrowserStore();
    store.load();
    await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());

    onEvent!({ event: event({
      kind: KIND_EMOJI_SET,
      pubkey: FOLLOW,
      created_at: 300,
      tags: [['d', 'dogs'], ['emoji', 'doge', 'https://emoji.example/doge.png']],
    }) });
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

  it('batches incoming emoji event rebuilds instead of rebuilding on every relay event', async () => {
    vi.useFakeTimers();
    try {
      let onEvent: ((result: RelayEventResult) => void) | null = null;
      vi.mocked(relay.subscribe).mockImplementation((_filter, eventCallback) => {
        onEvent = eventCallback as (result: RelayEventResult) => void;
        return { close: vi.fn() };
      });

      const onUpdate = vi.fn();
      const store = createEmojiBrowserStore(onUpdate);
      store.load();
      await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());
      onUpdate.mockClear();

      onEvent!({ event: event({
        id: 'set-1',
        pubkey: FOLLOW,
        created_at: 301,
        tags: [['d', 'set-1'], ['emoji', 'one', 'https://emoji.example/one.png']],
      }) });
      onEvent!({ event: event({
        id: 'set-2',
        pubkey: FOLLOW,
        created_at: 302,
        tags: [['d', 'set-2'], ['emoji', 'two', 'https://emoji.example/two.png']],
      }) });
      onEvent!({ event: event({
        id: 'set-3',
        pubkey: FOLLOW,
        created_at: 303,
        tags: [['d', 'set-3'], ['emoji', 'three', 'https://emoji.example/three.png']],
      }) });

      expect(store.state.items).toEqual([]);
      expect(onUpdate).not.toHaveBeenCalled();

      await vi.runOnlyPendingTimersAsync();

      expect(store.state.items.map((item) => item.shortcode)).toEqual(['three', 'two', 'one']);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#173 merge-safety on "Add to preferred emojis"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(identity.getPublicKey).mockResolvedValue(PUBKEY);
    vi.mocked(identity.getFollows).mockResolvedValue([FOLLOW]);
    vi.mocked(relay.query).mockResolvedValue([]);
    vi.mocked(relay.publish).mockResolvedValue(event({ kind: KIND_USER_EMOJI_LIST, pubkey: PUBKEY }));
  });

  function wireSubscription(): { fireEvent(e: NostrEvent): void; fireEose(): void } {
    let onEvent: ((result: RelayEventResult) => void) | null = null;
    let onEose: (() => void) | null = null;
    vi.mocked(relay.subscribe).mockImplementation((_filter, eventCallback, eoseCallback) => {
      onEvent = eventCallback as (result: RelayEventResult) => void;
      onEose = eoseCallback as () => void;
      return { close: vi.fn() };
    });
    return {
      fireEvent: (e) => onEvent!({ event: e }),
      fireEose: () => onEose!(),
    };
  }

  it('merges into a relay-truth 10030 carrying unicode, custom, a-ref, and unrelated tags', async () => {
    const sub = wireSubscription();
    const ownList = event({
      id: 'own-10030',
      kind: KIND_USER_EMOJI_LIST,
      pubkey: PUBKEY,
      created_at: 250,
      tags: [
        ['emoji', '😀'],
        ['emoji', 'oldcat', 'https://emoji.example/oldcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['client', 'someclient'],
      ],
    });

    const store = createEmojiBrowserStore();
    store.load();
    await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());

    // Relay-truth 10030 arrives over the live subscription (survives broken relay.query).
    sub.fireEvent(ownList);
    // A follow's set provides the emoji we will add.
    sub.fireEvent(event({
      kind: KIND_EMOJI_SET,
      pubkey: FOLLOW,
      created_at: 300,
      tags: [['d', 'dogs'], ['title', 'Dogs'], ['emoji', 'doge', 'https://emoji.example/doge.png']],
    }));
    sub.fireEose();

    const item = store.state.items.find((candidate) => candidate.shortcode === 'doge')!;
    await store.addToCollection(item);

    expect(relay.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: KIND_USER_EMOJI_LIST,
      tags: [
        ['emoji', '😀'],
        ['emoji', 'oldcat', 'https://emoji.example/oldcat.png', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['a', `${KIND_EMOJI_SET}:${PUBKEY}:cats`],
        ['client', 'someclient'],
        ['emoji', 'doge', 'https://emoji.example/doge.png', `${KIND_EMOJI_SET}:${FOLLOW}:dogs`],
      ],
    }));
  });

  it('publishes a single item only when the relay confirms there is genuinely no preferred list', async () => {
    const sub = wireSubscription();
    const store = createEmojiBrowserStore();
    store.load();
    await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());

    sub.fireEvent(event({
      kind: KIND_EMOJI_SET,
      pubkey: FOLLOW,
      created_at: 300,
      tags: [['d', 'dogs'], ['emoji', 'doge', 'https://emoji.example/doge.png']],
    }));
    // EOSE confirms relay truth: absence of a 10030 is now genuine.
    sub.fireEose();

    const item = store.state.items.find((candidate) => candidate.shortcode === 'doge')!;
    await store.addToCollection(item);

    expect(relay.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: KIND_USER_EMOJI_LIST,
      tags: [['emoji', 'doge', 'https://emoji.example/doge.png', `${KIND_EMOJI_SET}:${FOLLOW}:dogs`]],
    }));
  });

  it('BLOCKS the destructive publish when the preferred list could not be loaded (relay.query bug / no EOSE)', async () => {
    const sub = wireSubscription();
    const store = createEmojiBrowserStore();
    store.load();
    await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());

    // A follow's emoji arrives, but NO 10030 and NO EOSE: relay truth is unknown.
    sub.fireEvent(event({
      kind: KIND_EMOJI_SET,
      pubkey: FOLLOW,
      created_at: 300,
      tags: [['d', 'dogs'], ['emoji', 'doge', 'https://emoji.example/doge.png']],
    }));
    // Force the rebuild so the item is visible without EOSE.
    await vi.waitFor(() => expect(store.state.items.length).toBeGreaterThan(0));

    expect(store.state.preferredListConfirmed).toBe(false);

    const item = store.state.items.find((candidate) => candidate.shortcode === 'doge')!;
    await store.addToCollection(item);

    expect(relay.publish).not.toHaveBeenCalled();
    expect(store.state.error).toMatch(/overwriting your list/i);
  });
});

describe('#186 / #185 self-discovery authors', () => {
  it('includes the current user plus follows, deduped', () => {
    expect(discoveryAuthors(PUBKEY, [FOLLOW, PUBKEY, FOLLOW])).toEqual([PUBKEY, FOLLOW]);
    expect(discoveryAuthors(PUBKEY, [])).toEqual([PUBKEY]);
  });

  it('passes self+follows as the discovery filter authors', async () => {
    vi.clearAllMocks();
    vi.mocked(identity.getPublicKey).mockResolvedValue(PUBKEY);
    vi.mocked(identity.getFollows).mockResolvedValue([FOLLOW]);
    vi.mocked(relay.query).mockResolvedValue([]);
    vi.mocked(relay.subscribe).mockReturnValue({ close: vi.fn() });

    const store = createEmojiBrowserStore();
    store.load();
    await vi.waitFor(() => expect(relay.subscribe).toHaveBeenCalled());

    const filter = vi.mocked(relay.subscribe).mock.calls[0]![0] as { authors: string[] };
    expect(filter.authors).toEqual([PUBKEY, FOLLOW]);
  });
});

describe('#186 grouping + mine-first', () => {
  const OTHER = 'c'.repeat(64);

  const mineNew = emojiItem({ shortcode: 'mine-new', authorPubkey: PUBKEY, createdAt: 400, address: `${KIND_EMOJI_SET}:${PUBKEY}:a`, sourceTitle: 'My Pack' });
  const mineOld = emojiItem({ shortcode: 'mine-old', authorPubkey: PUBKEY, createdAt: 100, address: `${KIND_EMOJI_SET}:${PUBKEY}:a`, sourceTitle: 'My Pack' });
  const follow = emojiItem({ shortcode: 'follow', authorPubkey: FOLLOW, createdAt: 500, address: `${KIND_EMOJI_SET}:${FOLLOW}:z`, sourceTitle: 'Follow Pack' });
  const loose = emojiItem({ shortcode: 'loose', authorPubkey: OTHER, createdAt: 300, address: undefined, sourceTitle: 'List' });
  const all = [follow, loose, mineOld, mineNew];

  it('arrival mode: single headerless group, mine-first then newest', () => {
    const groups = groupEmojiItems(all, 'arrival', PUBKEY, true);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('arrival');
    expect(groups[0]!.items.map((i) => i.shortcode)).toEqual(['mine-new', 'mine-old', 'follow', 'loose']);
  });

  it('pack mode: groups by address, mine pack first, Ungrouped fallback for loose items', () => {
    const groups = groupEmojiItems(all, 'pack', PUBKEY, true);
    expect(groups[0]!.mine).toBe(true);
    expect(groups[0]!.title).toBe('My Pack');
    expect(groups.map((g) => g.title)).toContain('Ungrouped');
    expect(groups.map((g) => g.title)).toContain('Follow Pack');
  });

  it('pubkey mode: groups by author with mine first, header carries authorPubkey for profile:open', () => {
    const groups = groupEmojiItems(all, 'pubkey', PUBKEY, true);
    expect(groups[0]!.authorPubkey).toBe(PUBKEY);
    expect(groups[0]!.mine).toBe(true);
    expect(groups[0]!.items.map((i) => i.shortcode)).toEqual(['mine-new', 'mine-old']);
  });

  it('inlineMine=false hides the user\'s own emoji', () => {
    const groups = groupEmojiItems(all, 'arrival', PUBKEY, false);
    const shortcodes = groups.flatMap((g) => g.items.map((i) => i.shortcode));
    expect(shortcodes).not.toContain('mine-new');
    expect(shortcodes).not.toContain('mine-old');
    expect(shortcodes).toEqual(['follow', 'loose']);
  });
});

describe('#186 view prefs serialization', () => {
  it('round-trips group mode and inline-mine', () => {
    const raw = serializeEmojiBrowserPrefs({ groupMode: 'pubkey', inlineMine: false });
    expect(parseEmojiBrowserPrefs(raw)).toEqual({ groupMode: 'pubkey', inlineMine: false });
  });

  it('falls back to defaults for absent, malformed, or out-of-range values', () => {
    expect(parseEmojiBrowserPrefs(null)).toEqual({ groupMode: 'arrival', inlineMine: true });
    expect(parseEmojiBrowserPrefs('{not json')).toEqual({ groupMode: 'arrival', inlineMine: true });
    expect(parseEmojiBrowserPrefs(JSON.stringify({ groupMode: 'bogus', inlineMine: 'yes' })))
      .toEqual({ groupMode: 'arrival', inlineMine: true });
  });
});
