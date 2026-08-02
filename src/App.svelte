<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    loadResourceObjectUrls,
    resourceImage,
  } from '@hyprgate/utils';
  import { intent, storage } from '@napplet/sdk';
  import {
    createEmojiBrowserStore,
    createEmojiAuthorProfileIntentRequest,
    DEFAULT_EMOJI_BROWSER_PREFS,
    groupEmojiItems,
    isHandledEmojiAuthorProfileIntentResult,
    parseEmojiBrowserPrefs,
    serializeEmojiBrowserPrefs,
    type EmojiBrowserItem,
    type EmojiBrowserPrefs,
    type EmojiGroupMode,
  } from './lib/emoji-browser-store.js';
  import {
    createAuthorProfileResolver,
    fallbackAuthorIdentity,
    type AuthorIdentity,
    type AuthorIdentityMap,
  } from './lib/author-profiles.js';
  import {
    countTimedOutEmojiItems,
    countUnresolvedEmojiItems,
    EMOJI_RESOLVE_TIMEOUT_MS,
    setEmojiResolutionForSource,
    resolvedEmojiItems,
    retryTimedOutEmojiResolutions,
    selectActiveEmojiResolutionItems,
    syncEmojiResolutions,
    type EmojiResolutionMap,
    type EmojiResolveStatus,
  } from './lib/emoji-resolution.js';

  interface EmojiResolveParams {
    key: string;
    source: string;
    attempt: number;
  }

  const RESOLVED_RESOURCE_HINTS_KEY = 'emoji-browser:resolved-resource-sources:v1';
  const MAX_RESOLVED_RESOURCE_HINTS = 128;
  // NAP-STORAGE global (napplet-shared) scope: persists across window instances.
  const VIEW_PREFS_KEY = 'emoji-browser:prefs:v1';

  const GROUP_MODE_LABELS: Record<EmojiGroupMode, string> = {
    arrival: 'Arrival',
    pack: 'Pack',
    pubkey: 'Author',
  };

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
      currentPubkey: store.state.currentPubkey,
      preferredListConfirmed: store.state.preferredListConfirmed,
    };
  });

  let query = $state('');
  let selectedKey = $state<string | null>(null);
  let resolutionByKey = $state<EmojiResolutionMap>({});
  let resolvedSourceHints = $state<string[]>([]);
  let resolverUrlBySource = $state<Record<string, string>>({});

  let prefs = $state<EmojiBrowserPrefs>({ ...DEFAULT_EMOJI_BROWSER_PREFS });
  let authorIdentities = $state<AuthorIdentityMap>({});
  const profileResolver = createAuthorProfileResolver((identity) => {
    authorIdentities = { ...authorIdentities, [identity.pubkey]: identity };
  });

  function authorIdentity(pubkey: string): AuthorIdentity {
    return authorIdentities[pubkey] ?? fallbackAuthorIdentity(pubkey);
  }

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
  const resolverItems = $derived(
    selectActiveEmojiResolutionItems(filteredItems, state.items, resolutionByKey, undefined, resolvedSourceHints),
  );
  const unresolvedCount = $derived(countUnresolvedEmojiItems(state.items, resolutionByKey));
  const filteredUnresolvedCount = $derived(countUnresolvedEmojiItems(filteredItems, resolutionByKey));
  const timedOutCount = $derived(countTimedOutEmojiItems(state.items, resolutionByKey));

  const selected = $derived(
    visibleItems.find((item) => item.key === selectedKey) ?? visibleItems[0] ?? null,
  );

  const groups = $derived(
    groupEmojiItems(visibleItems, prefs.groupMode, state.currentPubkey, prefs.inlineMine),
  );

  // Resolve pubkey-group author identities lazily through NAP-COMMON.
  $effect(() => {
    if (prefs.groupMode !== 'pubkey') return;
    for (const group of groups) {
      if (group.authorPubkey) profileResolver.request(group.authorPubkey);
    }
  });

  onMount(() => {
    store.load();
    void loadResolvedSourceHints();
    void loadViewPrefs();
  });

  onDestroy(() => store.destroy());

  async function loadViewPrefs(): Promise<void> {
    try {
      const raw = await storage.getItem(VIEW_PREFS_KEY);
      prefs = parseEmojiBrowserPrefs(raw);
    } catch {
      // Persisted prefs are best-effort; defaults remain in effect.
    }
  }

  function persistViewPrefs(next: EmojiBrowserPrefs): void {
    prefs = next;
    void storage.setItem(VIEW_PREFS_KEY, serializeEmojiBrowserPrefs(next)).catch(() => {});
  }

  function setGroupMode(mode: EmojiGroupMode): void {
    if (prefs.groupMode === mode) return;
    persistViewPrefs({ ...prefs, groupMode: mode });
  }

  function toggleInlineMine(): void {
    persistViewPrefs({ ...prefs, inlineMine: !prefs.inlineMine });
  }

  async function openAuthorProfile(pubkey: string): Promise<void> {
    const request = createEmojiAuthorProfileIntentRequest(pubkey);
    if (!request) return;
    try {
      if (!isHandledEmojiAuthorProfileIntentResult(request, await intent.invoke(request))) return;
    } catch {
      // Keep the existing no-op behavior when profile navigation is unavailable.
    }
  }

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

  async function loadResolvedSourceHints(): Promise<void> {
    try {
      const raw = await storage.getItem(RESOLVED_RESOURCE_HINTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return;
      resolvedSourceHints = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
    } catch {
      // Storage is only a priority hint; resource service remains source of truth.
    }
  }

  function rememberResolvedSource(source: string): void {
    if (!source) return;
    const next = [source, ...resolvedSourceHints.filter((candidate) => candidate !== source)]
      .slice(0, MAX_RESOLVED_RESOURCE_HINTS);
    resolvedSourceHints = next;
    void storage.setItem(RESOLVED_RESOURCE_HINTS_KEY, JSON.stringify(next)).catch(() => {});
  }

  function setResolution(params: EmojiResolveParams, next: EmojiResolveStatus): void {
    replaceResolutionMap(setEmojiResolutionForSource(state.items, resolutionByKey, params.source, next));
    if (next === 'resolved') rememberResolvedSource(params.source);
  }

  function retryTimedOut(): void {
    replaceResolutionMap(retryTimedOutEmojiResolutions(resolutionByKey));
  }

  function setResolverUrl(source: string, resolvedUrl: string | null): void {
    if (resolvedUrl) {
      if (resolverUrlBySource[source] === resolvedUrl) return;
      resolverUrlBySource = { ...resolverUrlBySource, [source]: resolvedUrl };
      return;
    }
    if (!(source in resolverUrlBySource)) return;
    const next = { ...resolverUrlBySource };
    delete next[source];
    resolverUrlBySource = next;
  }

  function resolveEmojiImage(
    node: HTMLImageElement,
    params: EmojiResolveParams & { resolvedUrl: string | null },
  ) {
    let current = params;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function clearTimer(): void {
      if (timeout === null) return;
      clearTimeout(timeout);
      timeout = null;
    }

    function start(next: EmojiResolveParams & { resolvedUrl: string | null }): void {
      clearTimer();
      node.removeAttribute('src');
      timeout = setTimeout(() => {
        timeout = null;
        setResolution(next, 'timed-out');
      }, EMOJI_RESOLVE_TIMEOUT_MS);
      if (next.resolvedUrl) node.src = next.resolvedUrl;
    }

    function handleLoad(): void {
      clearTimer();
      setResolution(current, 'resolved');
    }

    function handleError(): void {
      clearTimer();
      setResolution(current, 'timed-out');
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
          && next.resolvedUrl === current.resolvedUrl
        ) return;
        current = next;
        start(current);
      },
      destroy(): void {
        clearTimer();
        node.removeEventListener('load', handleLoad);
        node.removeEventListener('error', handleError);
      },
    };
  }

  $effect(() => {
    replaceResolutionMap(syncEmojiResolutions(state.items, resolutionByKey));
  });

  $effect(() => {
    const items = resolverItems;
    if (items.length === 0) return;

    const subscription = loadResourceObjectUrls(
      items.map((item) => item.imageUrl),
      setResolverUrl,
      {
        refresh: items.some((item) => (resolutionByKey[item.key]?.attempt ?? 0) > 0),
      },
    );

    return () => subscription.close();
  });
</script>

<main>
  <header class="topbar">
    <div>
      <p>
        {state.items.length} loaded emoji from {state.followsCount} follows
        {#if unresolvedCount > 0}
          <span class="inline-muted">· {unresolvedCount} unresolved</span>
        {/if}
        {#if timedOutCount > 0}
          <span class="inline-muted">· {timedOutCount} timed out</span>
        {/if}
      </p>
    </div>
    <button type="button" class="ghost" disabled={state.loading} onclick={() => store.load()}>
      {state.loading ? 'Loading' : 'Refresh'}
    </button>
  </header>

  <section class="toolbar">
    <input bind:value={query} placeholder="Filter shortcode, set, or pubkey" aria-label="Filter emoji" />
    <div class="group-modes" role="group" aria-label="Group emoji by">
      {#each (['arrival', 'pack', 'pubkey'] as const) as mode (mode)}
        <button
          type="button"
          class="ghost mode"
          class:active={prefs.groupMode === mode}
          aria-pressed={prefs.groupMode === mode}
          onclick={() => setGroupMode(mode)}
        >
          {GROUP_MODE_LABELS[mode]}
        </button>
      {/each}
    </div>
    <button
      type="button"
      class="ghost mode"
      class:active={prefs.inlineMine}
      aria-pressed={prefs.inlineMine}
      title="Show your own emoji inline (pinned to top)"
      onclick={toggleInlineMine}
    >
      Inline mine
    </button>
    {#if timedOutCount > 0}
      <button type="button" class="ghost retry" onclick={retryTimedOut}>
        Try again ({timedOutCount})
      </button>
    {/if}
    {#if state.status}<span class="status">{state.status}</span>{/if}
    {#if state.error}<span class="status error">{state.error}</span>{/if}
  </section>

  <div class="resolver-bin" aria-hidden="true">
    {#each resolverItems as item (item.key)}
      <img
        use:resolveEmojiImage={{
          key: item.key,
          source: item.imageUrl,
          attempt: resolutionByKey[item.key]?.attempt ?? 0,
          resolvedUrl: resolverUrlBySource[item.imageUrl] ?? null,
        }}
        data-emoji-resolver
        data-shortcode={item.shortcode}
        alt=""
      />
    {/each}
  </div>

  <section class="layout">
    <div class="groups" aria-label="Discovered custom emoji">
      {#if groups.length === 0}
        <p class="empty">
          {#if state.loading}
            Loading custom emoji...
          {:else if filteredItems.length === 0}
            No custom emoji found.
          {:else if !prefs.inlineMine && visibleItems.length === 0}
            Your own emoji are hidden. Enable Inline mine to show them.
          {:else}
            Resolving custom emoji images. {filteredUnresolvedCount} unresolved.
          {/if}
        </p>
      {:else}
        {#each groups as group (group.key)}
          <div class="emoji-group">
            {#if group.kind !== 'arrival'}
              <div class="group-header" class:mine={group.mine}>
                {#if group.kind === 'pubkey'}
                  {@const author = authorIdentity(group.authorPubkey)}
                  <button
                    type="button"
                    class="author"
                    title={group.authorPubkey}
                    onclick={() => openAuthorProfile(group.authorPubkey)}
                  >
                    {#if author.picture}
                      <img class="author-avatar" use:resourceImage={author.picture} alt="" loading="lazy" />
                    {:else}
                      <span class="author-avatar placeholder" aria-hidden="true"></span>
                    {/if}
                    <span class="author-name">{author.label}</span>
                  </button>
                {:else}
                  <span class="group-title" title={group.title}>{group.title}</span>
                {/if}
                {#if group.mine}<span class="mine-badge">You</span>{/if}
              </div>
            {/if}
            <div class="grid">
              {#each group.items as item (item.key)}
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
            </div>
          </div>
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

  .groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: auto;
    padding-right: 2px;
  }

  .emoji-group {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
    grid-auto-rows: 92px;
    gap: 8px;
    min-height: 0;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    background: var(--hg-bg-base, #050505);
    border-bottom: 1px solid var(--hg-border-muted, #242424);
  }

  .group-header.mine {
    border-bottom-color: color-mix(in srgb, var(--hg-accent-green, #9be564) 50%, var(--hg-border-muted, #242424));
  }

  .group-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .author {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 4px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    border-radius: 4px;
  }

  .author:hover .author-name {
    color: var(--hg-accent-cyan, #82d8f7);
  }

  .author-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
    flex: none;
  }

  .author-avatar.placeholder {
    background: var(--hg-surface, #101010);
    border: 1px solid var(--hg-border, #303030);
  }

  .author-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .mine-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    color: var(--hg-accent-green, #9be564);
    border: 1px solid color-mix(in srgb, var(--hg-accent-green, #9be564) 50%, var(--hg-border, #303030));
  }

  .group-modes {
    display: inline-flex;
    gap: 4px;
  }

  .mode {
    white-space: nowrap;
  }

  .mode.active {
    border-color: var(--hg-accent-cyan, #82d8f7);
    color: var(--hg-accent-cyan, #82d8f7);
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
