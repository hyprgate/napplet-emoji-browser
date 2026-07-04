import type { NostrEvent, NostrFilter } from '@hyprgate/types';
import { KIND_EMOJI_SET, KIND_USER_EMOJI_LIST } from '@hyprgate/utils/emoji-sets';
import { parseCustomEmojiTags, type CustomEmojiResource } from '@hyprgate/utils';
import { identity, outbox, relay, type Subscription } from '@napplet/sdk';

interface NappletShellHandle {
  ready(): Promise<unknown>;
  supports(domain: string, protocol?: string): boolean;
}

function getShell(): NappletShellHandle | null {
  return (globalThis as unknown as { napplet?: { shell?: NappletShellHandle } }).napplet?.shell ?? null;
}

export interface EmojiBrowserItem {
  key: string;
  shortcode: string;
  imageUrl: string;
  address?: string;
  authorPubkey: string;
  eventId: string;
  eventKind: number;
  createdAt: number;
  sourceTitle: string;
  tag: string[];
  added: boolean;
}

export interface EmojiBrowserState {
  items: EmojiBrowserItem[];
  followsCount: number;
  loading: boolean;
  publishingKey: string | null;
  loaded: boolean;
  error: string | null;
  status: string | null;
  currentPubkey: string | null;
  /**
   * True once the user's own preferred-list (kind 10030) relay truth has been
   * established (a confirmed event arrived, or the relay confirmed absence via
   * EOSE). Until this is true, an "Add to preferred emojis" publish would risk
   * dropping existing entries, so the action is blocked (#173).
   */
  preferredListConfirmed: boolean;
}

export interface EmojiBrowserStore {
  state: EmojiBrowserState;
  load(): void;
  addToCollection(item: EmojiBrowserItem): Promise<void>;
  destroy(): void;
}

interface EmojiBrowserContext {
  state: EmojiBrowserState;
  itemsByKey: Map<string, EmojiBrowserItem>;
  collectionEvent: NostrEvent | null;
  /**
   * Whether the user's own kind 10030 relay truth has been established. Set when
   * the live subscription (which now includes the user's own author — see the
   * self-discovery fix) reaches EOSE, or when a confirmed 10030 event arrives.
   * This is the merge-safety gate for #173: a null `collectionEvent` only means
   * "genuinely no preferred list" once this is true; before that it means
   * "unknown / not yet loaded" and publishing must be blocked.
   */
  collectionConfirmed: boolean;
  subs: Subscription[];
  pendingEose: number;
  rebuildTimer: ReturnType<typeof setTimeout> | null;
  itemsDirty: boolean;
  notify(): void;
}

const USER_EMOJI_LIST_QUERY_LIMIT = 20;

export function createInitialEmojiBrowserState(): EmojiBrowserState {
  return {
    items: [],
    followsCount: 0,
    loading: false,
    publishingKey: null,
    loaded: false,
    error: null,
    status: null,
    currentPubkey: null,
    preferredListConfirmed: false,
  };
}

function destroy(ctx: EmojiBrowserContext): void {
  for (const sub of ctx.subs.splice(0)) sub.close();
  if (ctx.rebuildTimer !== null) {
    clearTimeout(ctx.rebuildTimer);
    ctx.rebuildTimer = null;
  }
  ctx.itemsDirty = false;
  ctx.pendingEose = 0;
}

function itemKey(emoji: Pick<CustomEmojiResource, 'shortcode' | 'imageUrl' | 'address'>, authorPubkey: string): string {
  return `${emoji.shortcode}\n${emoji.imageUrl}\n${emoji.address ?? ''}\n${authorPubkey}`;
}

function setAddress(event: NostrEvent): string | null {
  const identifier = event.tags.find((tag) => tag[0] === 'd')?.[1];
  return identifier ? `${KIND_EMOJI_SET}:${event.pubkey}:${identifier}` : null;
}

function sourceTitle(event: NostrEvent): string {
  return event.tags.find((tag) => tag[0] === 'title')?.[1] ?? (event.kind === KIND_EMOJI_SET ? 'Emoji set' : 'Emoji list');
}

export function normalizeFollowPubkeys(value: unknown): string[] {
  const follows = Array.isArray(value) ? value : [];
  return [...new Set(follows.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
}

export function latestUserEmojiListEvent(value: unknown, pubkey: string): NostrEvent | null {
  const events = Array.isArray(value) ? value as NostrEvent[] : [];
  return events
    .filter((event) => event.kind === KIND_USER_EMOJI_LIST && event.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

export function itemsFromEvent(event: NostrEvent, collectionTags: readonly (readonly string[])[] = []): EmojiBrowserItem[] {
  const fallbackAddress = event.kind === KIND_EMOJI_SET ? setAddress(event) : null;
  const collection = parseCustomEmojiTags(collectionTags);
  return parseCustomEmojiTags(event.tags).map((emoji) => {
    const address = emoji.address ?? fallbackAddress ?? undefined;
    const normalized = { ...emoji, ...(address ? { address } : {}) };
    return {
      key: itemKey(normalized, event.pubkey),
      shortcode: emoji.shortcode,
      imageUrl: emoji.imageUrl,
      ...(address ? { address } : {}),
      authorPubkey: event.pubkey,
      eventId: event.id,
      eventKind: event.kind,
      createdAt: event.created_at,
      sourceTitle: sourceTitle(event),
      tag: ['emoji', emoji.shortcode, emoji.imageUrl, ...(address ? [address] : [])],
      added: collection.some((existing) => existing.shortcode === emoji.shortcode && existing.imageUrl === emoji.imageUrl),
    };
  });
}

function rebuild(ctx: EmojiBrowserContext): void {
  const collectionTags = ctx.collectionEvent?.tags ?? [];
  const collection = parseCustomEmojiTags(collectionTags);
  const currentPubkey = ctx.state.currentPubkey;
  ctx.state.items = [...ctx.itemsByKey.values()]
    .map((item) => ({
      ...item,
      added: collection.some(
        (existing) => existing.shortcode === item.shortcode && existing.imageUrl === item.imageUrl,
      ),
    }))
    // Mine-first, then newest, then shortcode (#186). Grouping in the UI keeps
    // this order within each group.
    .sort((a, b) => {
      const aMine = currentPubkey !== null && a.authorPubkey === currentPubkey ? 0 : 1;
      const bMine = currentPubkey !== null && b.authorPubkey === currentPubkey ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      return b.createdAt - a.createdAt || a.shortcode.localeCompare(b.shortcode);
    });
  ctx.itemsDirty = false;
}

function flushRebuild(ctx: EmojiBrowserContext): boolean {
  if (ctx.rebuildTimer !== null) {
    clearTimeout(ctx.rebuildTimer);
    ctx.rebuildTimer = null;
  }
  if (!ctx.itemsDirty) return false;
  rebuild(ctx);
  return true;
}

function scheduleRebuild(ctx: EmojiBrowserContext): void {
  if (ctx.rebuildTimer !== null) return;
  ctx.rebuildTimer = setTimeout(() => {
    ctx.rebuildTimer = null;
    if (flushRebuild(ctx)) ctx.notify();
  }, 0);
}

function rememberCollectionEvent(ctx: EmojiBrowserContext, event: NostrEvent): boolean {
  if (event.kind !== KIND_USER_EMOJI_LIST || event.pubkey !== ctx.state.currentPubkey) return false;
  // The live subscription now carries the user's own 10030 (self-discovery fix),
  // which is a relay-truth source that survives the broken one-shot relay.query
  // (kehto/web#94). Adopt the newest confirmed list as merge truth.
  if (!ctx.collectionEvent || event.created_at >= ctx.collectionEvent.created_at) {
    ctx.collectionEvent = event;
  }
  ctx.collectionConfirmed = true;
  ctx.state.preferredListConfirmed = true;
  return true;
}

function rememberEvent(ctx: EmojiBrowserContext, event: NostrEvent): void {
  let changed = rememberCollectionEvent(ctx, event);
  for (const item of itemsFromEvent(event, ctx.collectionEvent?.tags ?? [])) {
    const existing = ctx.itemsByKey.get(item.key);
    if (!existing || item.createdAt >= existing.createdAt) {
      ctx.itemsByKey.set(item.key, item);
      changed = true;
    }
  }
  if (changed) {
    ctx.itemsDirty = true;
    scheduleRebuild(ctx);
  }
}

function handleEose(ctx: EmojiBrowserContext): void {
  ctx.pendingEose = Math.max(0, ctx.pendingEose - 1);
  if (ctx.pendingEose === 0) {
    ctx.state.loading = false;
    ctx.state.loaded = true;
    // EOSE on the discovery subscription (which includes the user's own author)
    // means the relay has reported everything it has, including the absence of a
    // 10030. A still-null collectionEvent now genuinely means "no preferred
    // list", so merging a single item is non-destructive (#173 merge-safety).
    ctx.collectionConfirmed = true;
    ctx.state.preferredListConfirmed = true;
  }
  flushRebuild(ctx);
  ctx.notify();
}

function subscribe(ctx: EmojiBrowserContext, filter: NostrFilter, useOutbox: boolean): void {
  ctx.pendingEose += 1;
  if (useOutbox) {
    const sub = outbox.subscribe(filter, { strategy: 'outbox', live: false });
    sub.on('event', (result) => rememberEvent(ctx, result.event as NostrEvent));
    sub.on('closed', () => handleEose(ctx));
    ctx.subs.push({ close: () => sub.close() });
    return;
  }
  ctx.subs.push(relay.subscribe(filter, (result) => rememberEvent(ctx, result.event as NostrEvent), () => handleEose(ctx)));
}

async function loadCollectionEvent(pubkey: string): Promise<NostrEvent | null> {
  // Best-effort one-shot read. Currently unreliable upstream: relay.query()
  // returns no events (kehto/web#94). We treat its result as advisory only — the
  // authoritative merge-truth comes from the live subscription / EOSE path
  // (rememberCollectionEvent / handleEose), so a null here never relaxes the
  // #173 merge-safety gate.
  try {
    const results = await relay.query([{ kinds: [KIND_USER_EMOJI_LIST], authors: [pubkey], limit: USER_EMOJI_LIST_QUERY_LIMIT }]);
    const events = results.map((result) => result.event as NostrEvent);
    return latestUserEmojiListEvent(events, pubkey);
  } catch {
    return null;
  }
}

/**
 * Discovery authors = the user themselves plus their follows, deduped. Including
 * self is required so the user's own kind 30030 sets surface (mine-first, #186)
 * and so the user's own kind 10030 preferred list is delivered over the live
 * subscription as merge truth (#173, also needed by #185 self-discovery).
 */
export function discoveryAuthors(pubkey: string, follows: string[]): string[] {
  return normalizeFollowPubkeys([pubkey, ...follows]);
}

async function load(ctx: EmojiBrowserContext): Promise<void> {
  destroy(ctx);
  ctx.itemsByKey.clear();
  ctx.collectionEvent = null;
  ctx.collectionConfirmed = false;
  ctx.itemsDirty = false;
  ctx.state.loading = true;
  ctx.state.loaded = false;
  ctx.state.error = null;
  ctx.state.status = null;
  ctx.state.preferredListConfirmed = false;
  ctx.state.items = [];
  ctx.notify();

  try {
    const [pubkey, rawFollows] = await Promise.all([
      identity.getPublicKey(),
      identity.getFollows().catch(() => []),
    ]);
    const follows = normalizeFollowPubkeys(rawFollows);
    ctx.state.currentPubkey = pubkey;
    ctx.state.followsCount = follows.length;
    const authors = discoveryAuthors(pubkey, follows);
    // Advisory one-shot read; authoritative truth arrives via the subscription.
    const queried = await loadCollectionEvent(pubkey);
    if (queried) {
      ctx.collectionEvent = queried;
      ctx.collectionConfirmed = true;
      ctx.state.preferredListConfirmed = true;
    }

    if (authors.length === 0) {
      // Should not happen now that self is always an author, but keep the guard.
      ctx.state.loading = false;
      ctx.state.loaded = true;
      ctx.state.preferredListConfirmed = true;
      ctx.notify();
      return;
    }

    const shell = getShell();
    await shell?.ready();
    const useOutbox = shell?.supports('outbox') ?? false;
    const filter: NostrFilter = { kinds: [KIND_USER_EMOJI_LIST, KIND_EMOJI_SET], authors, limit: 500 };
    subscribe(ctx, filter, useOutbox);
  } catch (error) {
    ctx.state.loading = false;
    ctx.state.loaded = true;
    ctx.state.error = error instanceof Error ? error.message : 'Unable to load custom emoji.';
    ctx.notify();
  }
}

export function buildCollectionTags(existing: NostrEvent | null, item: EmojiBrowserItem): string[][] {
  const tags = (existing?.tags ?? []).map((tag) => [...tag]);
  const alreadyPresent = tags.some(
    (tag) => tag[0] === 'emoji' && tag[1] === item.shortcode && tag[2] === item.imageUrl,
  );
  return alreadyPresent ? tags : [...tags, [...item.tag]];
}

function collectionHasItem(existing: NostrEvent | null, item: EmojiBrowserItem): boolean {
  return (existing?.tags ?? []).some(
    (tag) => tag[0] === 'emoji' && tag[1] === item.shortcode && tag[2] === item.imageUrl,
  );
}

async function addToCollection(ctx: EmojiBrowserContext, item: EmojiBrowserItem): Promise<void> {
  const pubkey = ctx.state.currentPubkey;
  if (!pubkey) throw new Error('Connect an identity before adding emoji.');
  if (item.added) {
    ctx.state.status = `:${item.shortcode}: is already in your collection.`;
    ctx.notify();
    return;
  }
  ctx.state.publishingKey = item.key;
  ctx.state.error = null;
  ctx.state.status = null;
  ctx.notify();
  try {
    const latest = await loadCollectionEvent(pubkey);
    if (latest && (!ctx.collectionEvent || latest.created_at >= ctx.collectionEvent.created_at)) {
      ctx.collectionEvent = latest;
      ctx.collectionConfirmed = true;
      ctx.state.preferredListConfirmed = true;
      ctx.itemsDirty = true;
    }
    // #173 merge-safety: never publish a list that could drop existing entries.
    // If relay truth for the user's own 10030 was never established (e.g. the
    // subscription has not reached EOSE yet, or reads failed), publishing now
    // would replace the real list with a one-item list. Block instead.
    if (!ctx.collectionConfirmed) {
      ctx.state.error =
        'Could not load your current preferred emoji from relays yet. ' +
        'Not saved, to avoid overwriting your list — refresh and try again.';
      return;
    }
    if (collectionHasItem(ctx.collectionEvent, item)) {
      ctx.state.status = `:${item.shortcode}: is already in your collection.`;
      flushRebuild(ctx);
      return;
    }
    const tags = buildCollectionTags(ctx.collectionEvent, item);
    const published = await relay.publish({
      kind: KIND_USER_EMOJI_LIST,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    }) as NostrEvent;
    ctx.collectionEvent = published ?? {
      id: `local-${Date.now()}`,
      pubkey,
      kind: KIND_USER_EMOJI_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      sig: '',
    };
    ctx.state.status = `Added :${item.shortcode}:`;
    ctx.itemsDirty = true;
    flushRebuild(ctx);
  } catch (error) {
    ctx.state.error = error instanceof Error ? error.message : 'Unable to add emoji.';
    throw error;
  } finally {
    ctx.state.publishingKey = null;
    ctx.notify();
  }
}

// --- #186: grouping, mine-first ordering, view preferences -----------------

export type EmojiGroupMode = 'arrival' | 'pack' | 'pubkey';

export interface EmojiBrowserPrefs {
  groupMode: EmojiGroupMode;
  inlineMine: boolean;
}

export interface EmojiBrowserGroup {
  /** Stable group key: '' for arrival mode, address for pack, pubkey for pubkey. */
  key: string;
  /** Grouping dimension, so the UI can pick the right header renderer. */
  kind: 'arrival' | 'pack' | 'pubkey';
  /** Display label (pack title or short fallback); pubkey headers resolve identity in UI. */
  title: string;
  /** Author pubkey for pubkey-mode headers / profile:open intent; '' otherwise. */
  authorPubkey: string;
  /** True when every item in the group belongs to the current user. */
  mine: boolean;
  items: EmojiBrowserItem[];
}

export const DEFAULT_EMOJI_BROWSER_PREFS: EmojiBrowserPrefs = {
  groupMode: 'arrival',
  inlineMine: true,
};

const GROUP_MODES: ReadonlySet<EmojiGroupMode> = new Set(['arrival', 'pack', 'pubkey']);

export function normalizeEmojiBrowserPrefs(value: unknown): EmojiBrowserPrefs {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const groupMode = typeof raw.groupMode === 'string' && GROUP_MODES.has(raw.groupMode as EmojiGroupMode)
    ? raw.groupMode as EmojiGroupMode
    : DEFAULT_EMOJI_BROWSER_PREFS.groupMode;
  const inlineMine = typeof raw.inlineMine === 'boolean'
    ? raw.inlineMine
    : DEFAULT_EMOJI_BROWSER_PREFS.inlineMine;
  return { groupMode, inlineMine };
}

export function parseEmojiBrowserPrefs(raw: string | null): EmojiBrowserPrefs {
  if (!raw) return { ...DEFAULT_EMOJI_BROWSER_PREFS };
  try {
    return normalizeEmojiBrowserPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_EMOJI_BROWSER_PREFS };
  }
}

export function serializeEmojiBrowserPrefs(prefs: EmojiBrowserPrefs): string {
  return JSON.stringify(normalizeEmojiBrowserPrefs(prefs));
}

function isMine(item: EmojiBrowserItem, currentPubkey: string | null): boolean {
  return currentPubkey !== null && item.authorPubkey === currentPubkey;
}

/** Mine-first, then newest, then shortcode — the within-group / flat ordering. */
function compareItems(a: EmojiBrowserItem, b: EmojiBrowserItem, currentPubkey: string | null): number {
  const aMine = isMine(a, currentPubkey) ? 0 : 1;
  const bMine = isMine(b, currentPubkey) ? 0 : 1;
  if (aMine !== bMine) return aMine - bMine;
  return b.createdAt - a.createdAt || a.shortcode.localeCompare(b.shortcode);
}

/**
 * Build display groups from already-resolved items.
 *
 * - `arrival`: a single headerless group, mine-first then newest.
 * - `pack`: grouped by 30030 address (loose 10030 entries fall into "Ungrouped").
 * - `pubkey`: grouped by author pubkey; the UI resolves the avatar/name header.
 *
 * In every mode the current user's items sort first within a group, and the
 * user's own groups sort ahead of others (mine-first). When `inlineMine` is
 * false, the user's own items are omitted from the result (hidden), per the
 * agreed #186 interpretation.
 */
export function groupEmojiItems(
  items: readonly EmojiBrowserItem[],
  groupMode: EmojiGroupMode,
  currentPubkey: string | null,
  inlineMine: boolean,
): EmojiBrowserGroup[] {
  const visible = inlineMine ? items : items.filter((item) => !isMine(item, currentPubkey));

  if (groupMode === 'arrival') {
    if (visible.length === 0) return [];
    return [{
      key: '',
      kind: 'arrival',
      title: '',
      authorPubkey: '',
      mine: visible.every((item) => isMine(item, currentPubkey)),
      items: [...visible].sort((a, b) => compareItems(a, b, currentPubkey)),
    }];
  }

  const order: string[] = [];
  const buckets = new Map<string, EmojiBrowserItem[]>();
  for (const item of visible) {
    const key = groupMode === 'pack' ? (item.address ?? '') : item.authorPubkey;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(item);
  }

  const groups: EmojiBrowserGroup[] = order.map((key) => {
    const groupItems = [...buckets.get(key)!].sort((a, b) => compareItems(a, b, currentPubkey));
    const head = groupItems[0]!;
    const mine = currentPubkey !== null && groupItems.every((item) => item.authorPubkey === currentPubkey);
    if (groupMode === 'pack') {
      return {
        key,
        kind: 'pack' as const,
        title: key === '' ? 'Ungrouped' : head.sourceTitle,
        authorPubkey: '',
        mine,
        items: groupItems,
      };
    }
    return {
      key,
      kind: 'pubkey' as const,
      title: key,
      authorPubkey: key,
      mine,
      items: groupItems,
    };
  });

  // Mine-first across groups; then by newest item in the group, then label.
  return groups.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    const aNewest = a.items[0]?.createdAt ?? 0;
    const bNewest = b.items[0]?.createdAt ?? 0;
    return bNewest - aNewest || a.title.localeCompare(b.title);
  });
}

export function createEmojiBrowserStore(onUpdate?: () => void): EmojiBrowserStore {
  const ctx: EmojiBrowserContext = {
    state: createInitialEmojiBrowserState(),
    itemsByKey: new Map(),
    collectionEvent: null,
    collectionConfirmed: false,
    subs: [],
    pendingEose: 0,
    rebuildTimer: null,
    itemsDirty: false,
    notify: () => onUpdate?.(),
  };

  return {
    state: ctx.state,
    load: () => { void load(ctx); },
    addToCollection: (item) => addToCollection(ctx, item),
    destroy: () => destroy(ctx),
  };
}
