<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    loadResourceObjectUrl,
    resourceImage,
    type ResourceObjectUrlSubscription,
  } from '@hyprgate/utils';
  import { createEmojiBrowserStore, type EmojiBrowserItem } from './lib/emoji-browser-store.js';
  import {
    countTimedOutEmojiItems,
    countUnresolvedEmojiItems,
    EMOJI_RESOLVE_TIMEOUT_MS,
    resolvedEmojiItems,
    retryTimedOutEmojiResolutions,
    setEmojiResolution,
    syncEmojiResolutions,
    type EmojiResolutionMap,
    type EmojiResolveStatus,
  } from './lib/emoji-resolution.js';

  interface EmojiResolveParams {
    key: string;
    source: string;
    attempt: number;
  }

  let version = $state(0);
  const store = createEmojiBrowserStore(() => {
    version += 1;
  });

  const state = $derived.by(() => {
    version;
    return {
      items: store.state.items,
      followsCount: store.state.followsCount,
      loading: store.state.loading,
      loaded: store.state.loaded,
      error: store.state.error,
      status: store.state.status,
      publishingKey: store.state.publishingKey,
    };
  });

  let query = $state('');
  let selectedKey = $state<string | null>(null);
  let resolutionByKey = $state<EmojiResolutionMap>({});

  const filteredItems = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.items;
    return state.items.filter((item) =>
      item.shortcode.toLowerCase().includes(needle)
      || item.sourceTitle.toLowerCase().includes(needle)
      || item.authorPubkey.toLowerCase().includes(needle),
    );
  });
  const visibleItems = $derived(resolvedEmojiItems(filteredItems, resolutionByKey));
  const unresolvedCount = $derived(countUnresolvedEmojiItems(state.items, resolutionByKey));
  const filteredUnresolvedCount = $derived(countUnresolvedEmojiItems(filteredItems, resolutionByKey));
  const timedOutCount = $derived(countTimedOutEmojiItems(state.items, resolutionByKey));

  const selected = $derived(
    visibleItems.find((item) => item.key === selectedKey) ?? visibleItems[0] ?? null,
  );

  onMount(() => {
    store.load();
  });

  onDestroy(() => store.destroy());

  function shortPubkey(pubkey: string): string {
    return pubkey.length > 12 ? `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}` : pubkey;
  }

  async function add(item: EmojiBrowserItem): Promise<void> {
    try {
      await store.addToCollection(item);
    } catch {
      // Store state carries the visible error.
    }
  }

  function replaceResolutionMap(next: EmojiResolutionMap): void {
    if (next !== resolutionByKey) resolutionByKey = next;
  }

  function setResolution(key: string, next: EmojiResolveStatus): void {
    replaceResolutionMap(setEmojiResolution(resolutionByKey, key, next));
  }

  function retryTimedOut(): void {
    replaceResolutionMap(retryTimedOutEmojiResolutions(resolutionByKey));
  }

  function resolveEmojiImage(node: HTMLImageElement, params: EmojiResolveParams) {
    let current = params;
    let subscription: ResourceObjectUrlSubscription | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function clearTimer(): void {
      if (timeout === null) return;
      clearTimeout(timeout);
      timeout = null;
    }

    function closeSubscription(): void {
      subscription?.close();
      subscription = null;
    }

    function start(next: EmojiResolveParams): void {
      clearTimer();
      closeSubscription();
      node.removeAttribute('src');
      timeout = setTimeout(() => {
        timeout = null;
        setResolution(next.key, 'timed-out');
      }, EMOJI_RESOLVE_TIMEOUT_MS);
      subscription = loadResourceObjectUrl(next.source, (resolvedUrl) => {
        if (resolvedUrl) node.src = resolvedUrl;
        else node.removeAttribute('src');
      }, {
        refresh: next.attempt > 0,
        onError: () => setResolution(next.key, 'timed-out'),
      });
    }

    function handleLoad(): void {
      clearTimer();
      setResolution(current.key, 'resolved');
    }

    function handleError(): void {
      setResolution(current.key, 'timed-out');
    }

    node.addEventListener('load', handleLoad);
    node.addEventListener('error', handleError);
    start(current);

    return {
      update(next: EmojiResolveParams): void {
        if (
          next.key === current.key
          && next.source === current.source
          && next.attempt === current.attempt
        ) return;
        current = next;
        start(current);
      },
      destroy(): void {
        clearTimer();
        closeSubscription();
        node.removeEventListener('load', handleLoad);
        node.removeEventListener('error', handleError);
      },
    };
  }

  $effect(() => {
    replaceResolutionMap(syncEmojiResolutions(state.items, resolutionByKey));
  });
</script>

<main>
  <header class="topbar">
    <div>
      <p>
        {state.items.length - unresolvedCount} emoji from {state.followsCount} follows
        {#if unresolvedCount > 0}
          <span class="inline-muted">· {unresolvedCount} unresolved</span>
        {/if}
      </p>
    </div>
    <button type="button" class="ghost" disabled={state.loading} onclick={() => store.load()}>
      {state.loading ? 'Loading' : 'Refresh'}
    </button>
  </header>

  <section class="toolbar">
    <input bind:value={query} placeholder="Filter shortcode, set, or pubkey" aria-label="Filter emoji" />
    {#if timedOutCount > 0}
      <button type="button" class="ghost retry" onclick={retryTimedOut}>
        Try again ({timedOutCount})
      </button>
    {/if}
    {#if state.status}<span class="status">{state.status}</span>{/if}
    {#if state.error}<span class="status error">{state.error}</span>{/if}
  </section>

  <div class="resolver-bin" aria-hidden="true">
    {#each state.items as item (item.key)}
      {#if resolutionByKey[item.key]?.status !== 'resolved'}
        <img
          use:resolveEmojiImage={{
            key: item.key,
            source: item.imageUrl,
            attempt: resolutionByKey[item.key]?.attempt ?? 0,
          }}
          data-emoji-resolver
          data-shortcode={item.shortcode}
          alt=""
        />
      {/if}
    {/each}
  </div>

  <section class="layout">
    <div class="grid" aria-label="Discovered custom emoji">
      {#if visibleItems.length === 0}
        <p class="empty">
          {#if state.loading}
            Loading custom emoji...
          {:else if filteredItems.length === 0}
            No custom emoji found.
          {:else}
            Resolving custom emoji images. {filteredUnresolvedCount} unresolved.
          {/if}
        </p>
      {:else}
        {#each visibleItems as item (item.key)}
          <button
            type="button"
            class="emoji-card"
            class:selected={selected?.key === item.key}
            class:added={item.added}
            onclick={() => (selectedKey = item.key)}
            title={`:${item.shortcode}:`}
          >
            <img use:resourceImage={item.imageUrl} alt={`:${item.shortcode}:`} loading="lazy" />
            <span>:{item.shortcode}:</span>
          </button>
        {/each}
      {/if}
    </div>

    <aside class="detail" aria-label="Selected emoji">
      {#if selected}
        <div class="preview">
          <img use:resourceImage={selected.imageUrl} alt={`:${selected.shortcode}:`} loading="lazy" />
        </div>
        <div class="meta">
          <h2>:{selected.shortcode}:</h2>
          <dl>
            <div><dt>Source</dt><dd>{selected.sourceTitle}</dd></div>
            <div><dt>Author</dt><dd title={selected.authorPubkey}>{shortPubkey(selected.authorPubkey)}</dd></div>
            {#if selected.address}
              <div><dt>Set</dt><dd title={selected.address}>{selected.address}</dd></div>
            {/if}
          </dl>
        </div>
        <button
          type="button"
          class="add"
          disabled={selected.added || state.publishingKey === selected.key}
          onclick={() => void add(selected)}
        >
          {#if selected.added}Added
          {:else if state.publishingKey === selected.key}Adding
          {:else}Add to preferred emojis{/if}
        </button>
        <p class="pack-note">Use Emoji Sets to add this emoji to a named pack.</p>
      {:else}
        <p class="empty">Select an emoji.</p>
      {/if}
    </aside>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg-base, #050505);
    color: var(--hg-text-primary, #f2efe7);
    font: 13px/1.5 var(--hg-font-body, ui-monospace, monospace);
  }

  main {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 10px;
    height: 100vh;
    box-sizing: border-box;
    padding: 12px;
    overflow: hidden;
  }

  .topbar,
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .topbar {
    justify-content: space-between;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 15px;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  p,
  .status,
  .inline-muted,
  dt {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
  }

  input {
    flex: 1;
    min-width: 0;
    height: 30px;
    box-sizing: border-box;
    border: 1px solid var(--hg-border, #303030);
    border-radius: 4px;
    background: var(--hg-surface, #101010);
    color: inherit;
    font: inherit;
    padding: 0 8px;
  }

  input:focus {
    outline: none;
    border-color: var(--hg-accent-cyan, #82d8f7);
  }

  .resolver-bin {
    position: fixed;
    left: -10000px;
    top: 0;
    width: 1px;
    height: 1px;
    overflow: hidden;
    pointer-events: none;
  }

  .resolver-bin img {
    width: 1px;
    height: 1px;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
    gap: 10px;
    min-height: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
    grid-auto-rows: 92px;
    gap: 8px;
    min-height: 0;
    overflow: auto;
    padding-right: 2px;
  }

  .emoji-card,
  .detail,
  .ghost,
  .add {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: var(--hg-surface, #101010);
    color: inherit;
    font: inherit;
  }

  .emoji-card {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    place-items: center;
    gap: 4px;
    min-width: 0;
    padding: 8px;
    cursor: pointer;
  }

  .emoji-card:hover,
  .emoji-card.selected {
    border-color: var(--hg-accent-cyan, #82d8f7);
  }

  .emoji-card.added {
    border-color: color-mix(in srgb, var(--hg-accent-green, #9be564) 60%, var(--hg-border, #303030));
  }

  .emoji-card img {
    width: 42px;
    height: 42px;
    object-fit: contain;
  }

  .emoji-card span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
    white-space: nowrap;
  }

  .detail {
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    gap: 10px;
    min-width: 0;
    min-height: 0;
    padding: 10px;
  }

  .preview {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border: 1px solid var(--hg-border-muted, #242424);
    border-radius: 6px;
    background: var(--hg-bg-base, #050505);
  }

  .preview img {
    width: min(72%, 180px);
    height: min(72%, 180px);
    object-fit: contain;
  }

  dl {
    display: grid;
    gap: 6px;
    margin: 0;
  }

  dl div {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ghost,
  .add {
    min-height: 30px;
    padding: 0 10px;
    cursor: pointer;
  }

  .retry {
    white-space: nowrap;
  }

  .add {
    border-color: var(--hg-accent-green, #9be564);
    color: var(--hg-accent-green, #9be564);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .error {
    color: var(--hg-accent-red, #ff6b6b);
  }

  .pack-note {
    margin: -4px 0 0;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
  }

  .empty {
    align-self: start;
    justify-self: start;
    padding: 10px;
  }

  @media (max-width: 720px) {
    .layout {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) auto;
    }

    .detail {
      grid-template-columns: 84px minmax(0, 1fr) auto;
      grid-template-rows: auto;
      align-items: center;
    }

    .preview {
      width: 84px;
      aspect-ratio: 1;
    }
  }
</style>
