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
  subs: Subscription[];
  pendingEose: number;
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
  };
}

function destroy(ctx: EmojiBrowserContext): void {
  for (const sub of ctx.subs.splice(0)) sub.close();
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
  ctx.state.items = [...ctx.itemsByKey.values()]
    .map((item) => ({
      ...item,
      added: parseCustomEmojiTags(collectionTags).some(
        (existing) => existing.shortcode === item.shortcode && existing.imageUrl === item.imageUrl,
      ),
    }))
    .sort((a, b) => b.createdAt - a.createdAt || a.shortcode.localeCompare(b.shortcode));
}

function rememberEvent(ctx: EmojiBrowserContext, event: NostrEvent): void {
  for (const item of itemsFromEvent(event, ctx.collectionEvent?.tags ?? [])) {
    const existing = ctx.itemsByKey.get(item.key);
    if (!existing || item.createdAt >= existing.createdAt) ctx.itemsByKey.set(item.key, item);
  }
  rebuild(ctx);
  ctx.notify();
}

function handleEose(ctx: EmojiBrowserContext): void {
  ctx.pendingEose = Math.max(0, ctx.pendingEose - 1);
  if (ctx.pendingEose === 0) {
    ctx.state.loading = false;
    ctx.state.loaded = true;
  }
  rebuild(ctx);
  ctx.notify();
}

function subscribe(ctx: EmojiBrowserContext, filter: NostrFilter, useOutbox: boolean): void {
  ctx.pendingEose += 1;
  if (useOutbox) {
    const sub = outbox.subscribe(filter, { strategy: 'outbox', live: true });
    sub.on('event', (event) => rememberEvent(ctx, event as NostrEvent));
    sub.on('eose', () => handleEose(ctx));
    ctx.subs.push({ close: () => sub.close() });
    return;
  }
  ctx.subs.push(relay.subscribe(filter, (event) => rememberEvent(ctx, event as NostrEvent), () => handleEose(ctx)));
}

async function loadCollectionEvent(pubkey: string): Promise<NostrEvent | null> {
  const events = await relay.query([{ kinds: [KIND_USER_EMOJI_LIST], authors: [pubkey], limit: USER_EMOJI_LIST_QUERY_LIMIT }]);
  return latestUserEmojiListEvent(events, pubkey);
}

async function load(ctx: EmojiBrowserContext): Promise<void> {
  destroy(ctx);
  ctx.itemsByKey.clear();
  ctx.collectionEvent = null;
  ctx.state.loading = true;
  ctx.state.loaded = false;
  ctx.state.error = null;
  ctx.state.status = null;
  ctx.state.items = [];
  ctx.notify();

  try {
    const [pubkey, rawFollows] = await Promise.all([
      identity.getPublicKey(),
      identity.getFollows().catch(() => []),
    ]);
    const follows = normalizeFollowPubkeys(rawFollows);
    ctx.state.currentPubkey = pubkey;
    const authors = follows;
    ctx.state.followsCount = authors.length;
    ctx.collectionEvent = await loadCollectionEvent(pubkey);

    if (authors.length === 0) {
      ctx.state.loading = false;
      ctx.state.loaded = true;
      rebuild(ctx);
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
    }
    if (collectionHasItem(ctx.collectionEvent, item)) {
      ctx.state.status = `:${item.shortcode}: is already in your collection.`;
      rebuild(ctx);
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
    rebuild(ctx);
  } catch (error) {
    ctx.state.error = error instanceof Error ? error.message : 'Unable to add emoji.';
    throw error;
  } finally {
    ctx.state.publishingKey = null;
    ctx.notify();
  }
}

export function createEmojiBrowserStore(onUpdate?: () => void): EmojiBrowserStore {
  const ctx: EmojiBrowserContext = {
    state: createInitialEmojiBrowserState(),
    itemsByKey: new Map(),
    collectionEvent: null,
    subs: [],
    pendingEose: 0,
    notify: () => onUpdate?.(),
  };

  return {
    state: ctx.state,
    load: () => { void load(ctx); },
    addToCollection: (item) => addToCollection(ctx, item),
    destroy: () => destroy(ctx),
  };
}
