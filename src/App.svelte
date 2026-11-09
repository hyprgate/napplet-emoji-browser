<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    invokeNappletIntent,
    loadResourceObjectUrls,
    resourceImage,
  } from '@hyprgate/utils';
  import { intent, storage } from '@napplet/sdk';
  import {
    createEmojiBrowserStore,
    ambiguousShortcodes,
    createEmojiAuthorProfileIntentRequest,
    DEFAULT_EMOJI_BROWSER_PREFS,
    emojiSummary,
    groupEmojiItems,
    isAcceptedEmojiAuthorProfileIntentResult,
    parseEmojiBrowserPrefs,
    serializeEmojiBrowserPrefs,
    uniqueEmojiItems,
    type EmojiBrowserItem,
    type EmojiBrowserPrefs,
    type EmojiGroupMode,
  } from './lib/emoji-browser-store.js';
  import {
    authorNpub,
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

  const uniqueItems = $derived(uniqueEmojiItems(state.items));
  const filteredItems = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return uniqueItems;
    return uniqueItems.filter((item) =>
      item.shortcode.toLowerCase().includes(needle)
      || item.sourceTitle.toLowerCase().includes(needle)
      || authorIdentity(item.authorPubkey).label.toLowerCase().includes(needle),
    );
  });
  const visibleItems = $derived(resolvedEmojiItems(filteredItems, resolutionByKey));
  const resolverItems = $derived(
    selectActiveEmojiResolutionItems(filteredItems, state.items, resolutionByKey, undefined, resolvedSourceHints),
  );
  const unresolvedCount = $derived(countUnresolvedEmojiItems(uniqueItems, resolutionByKey));
  const filteredUnresolvedCount = $derived(countUnresolvedEmojiItems(filteredItems, resolutionByKey));
  const timedOutCount = $derived(countTimedOutEmojiItems(uniqueItems, resolutionByKey));
  const summary = $derived(emojiSummary(uniqueItems, state.followsCount, state.currentPubkey));

  const groups = $derived(
    groupEmojiItems(visibleItems, prefs.groupMode, state.currentPubkey, prefs.inlineMine),
  );
  const ambiguous = $derived(ambiguousShortcodes(visibleItems));

  // From the groups, not all items: your own can be hidden, and a hidden emoji can't be selected.
  const selected = $derived.by(() => {
    const shown = groups.flatMap((group) => group.items);
    return shown.find((item) => item.key === selectedKey) ?? shown[0] ?? null;
  });
  const selectedAuthor = $derived(selected ? authorIdentity(selected.authorPubkey) : null);

  // Search and the detail pane both use names, so resolve them up front through NAP-COMMON.
  $effect(() => {
    for (const item of uniqueItems) profileResolver.request(item.authorPubkey);
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
      if (!isAcceptedEmojiAuthorProfileIntentResult(request, await invokeNappletIntent(request))) return;
    } catch {
      // Keep the existing no-op behavior when profile navigation is unavailable.
    }
  }

  // The store's error and status describe the last add, so only show them with that emoji.
  let lastAddKey = $state<string | null>(null);

  async function add(item: EmojiBrowserItem): Promise<void> {
    lastAddKey = item.key;
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
    <p>
      {#if state.items.length > 0 || !state.loading}{summary}{:else}Looking for custom emoji...{/if}
      {#if unresolvedCount - timedOutCount > 0}
        <span class="inline-muted">· {unresolvedCount - timedOutCount} still loading</span>
      {/if}
      {#if timedOutCount > 0}
        <span class="inline-muted">· {timedOutCount} didn't load</span>
        <button type="button" class="link retry" onclick={retryTimedOut}>Try again</button>
      {/if}
    </p>
    <button type="button" class="ghost" disabled={state.loading} onclick={() => store.load()}>
      {state.loading ? 'Loading' : 'Refresh'}
    </button>
  </header>

  <section class="toolbar">
    <input bind:value={query} placeholder="Search by shortcode, pack or person" aria-label="Search emoji" />
    <div class="group-control">
      <span id="group-by-label" class="control-label">Group by</span>
      <div class="group-modes" role="group" aria-labelledby="group-by-label">
        {#each (['arrival', 'pack', 'pubkey'] as const) as mode (mode)}
          <button
            type="button"
            class="mode"
            class:active={prefs.groupMode === mode}
            aria-pressed={prefs.groupMode === mode}
            onclick={() => setGroupMode(mode)}
          >
            {GROUP_MODE_LABELS[mode]}
          </button>
        {/each}
      </div>
    </div>
    <label class="show-mine" title="Show your own emoji, pinned to the top">
      <input type="checkbox" checked={prefs.inlineMine} onchange={toggleInlineMine} />
      Show mine
    </label>
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
            Looking for custom emoji...
          {:else if query.trim() && filteredItems.length === 0}
            No emoji match “{query.trim()}”.
            <button type="button" class="link" onclick={() => (query = '')}>Clear search</button>
          {:else if filteredItems.length === 0}
            No custom emoji from the people you follow yet. When someone publishes a pack, it'll show up here.
          {:else if !prefs.inlineMine && visibleItems.length > 0}
            These are all your own emoji, which are hidden. Turn on Show mine to see them.
          {:else}
            Loading {filteredUnresolvedCount} emoji images...
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
                    title={authorNpub(group.authorPubkey)}
                    onclick={() => openAuthorProfile(group.authorPubkey)}
                  >
                    <span class="author-avatar-shell">
                      <span class="author-avatar placeholder" aria-hidden="true"></span>
                      {#if author.picture}
                        <img class="author-avatar" use:resourceImage={author.picture} alt="" loading="lazy" />
                      {/if}
                    </span>
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
                  aria-pressed={selected?.key === item.key}
                  onclick={() => (selectedKey = item.key)}
                  title={`:${item.shortcode}:`}
                >
                  <img use:resourceImage={item.imageUrl} alt={`:${item.shortcode}:`} loading="lazy" />
                  <span>:{item.shortcode}:</span>
                  {#if ambiguous.has(item.shortcode)}<small title={item.sourceTitle}>{item.sourceTitle}</small>{/if}
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
          <p class="source">From {selected.address ? 'the pack' : 'the list'} <strong>{selected.sourceTitle}</strong></p>
          {#if selectedAuthor}
            <button
              type="button"
              class="author"
              title={authorNpub(selected.authorPubkey)}
              onclick={() => openAuthorProfile(selected.authorPubkey)}
            >
              <span class="author-avatar-shell">
                <span class="author-avatar placeholder" aria-hidden="true"></span>
                {#if selectedAuthor.picture}
                  <img class="author-avatar" use:resourceImage={selectedAuthor.picture} alt="" loading="lazy" />
                {/if}
              </span>
              <span class="author-name">{selectedAuthor.label}</span>
              {#if selected.authorPubkey === state.currentPubkey}<span class="mine-badge">You</span>{/if}
            </button>
          {/if}
        </div>
        <button
          type="button"
          class="add"
          disabled={selected.added || state.publishingKey === selected.key}
          onclick={() => void add(selected)}
        >
          {#if selected.added}In your quick-react list ✓
          {:else if state.publishingKey === selected.key}Adding...
          {:else}Add to my quick-react list{/if}
        </button>
        <div class="detail-note" aria-live="polite">
          {#if state.error && (lastAddKey === selected.key || lastAddKey === null)}<p class="error">{lastAddKey ? `Couldn't add it: ${state.error}` : state.error}</p>
          {:else if state.status && lastAddKey === selected.key}<p class="ok">{state.status}</p>
          {:else}<p class="pack-note">To put it in a named set, use Emoji Sets.</p>{/if}
        </div>
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
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .toolbar > input {
    flex: 1 1 220px;
  }

  .group-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .control-label {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 11px;
  }

  .show-mine {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }

  .show-mine input {
    flex: none;
    height: auto;
    margin: 0;
    accent-color: var(--hg-accent-cyan, #82d8f7);
  }

  .link {
    border: 0;
    background: none;
    color: var(--hg-accent-cyan, #82d8f7);
    cursor: pointer;
    font: inherit;
    padding: 0 2px;
    text-decoration: underline;
  }

  button:focus-visible, .show-mine input:focus-visible {
    outline: 2px solid var(--hg-accent-cyan, #82d8f7);
    outline-offset: 1px;
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
    grid-auto-rows: 108px;
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

  .author-avatar-shell {
    display: grid;
    width: 20px;
    height: 20px;
    flex: none;
  }

  .author-avatar {
    grid-area: 1 / 1;
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
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    overflow: hidden;
  }

  .mode {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    background: var(--hg-surface, #101010);
    color: var(--hg-text-muted, #b8b1a4);
    cursor: pointer;
    font: inherit;
    white-space: nowrap;
  }

  .mode + .mode {
    border-left: 1px solid var(--hg-border, #303030);
  }

  .mode.active {
    background: color-mix(in srgb, var(--hg-accent-cyan, #82d8f7) 22%, var(--hg-surface, #101010));
    color: var(--hg-text-primary, #f2efe7);
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
    grid-template-rows: minmax(0, 1fr) auto auto;
    place-items: center;
    gap: 2px;
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

  .emoji-card small {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--hg-accent-cyan, #82d8f7);
    font-size: 10px;
    white-space: nowrap;
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
    align-content: start;
    gap: 10px;
    min-width: 0;
    min-height: 0;
    padding: 10px;
  }

  .preview {
    display: grid;
    place-items: center;
    height: 150px;
    border: 1px solid var(--hg-border-muted, #242424);
    border-radius: 6px;
    background: var(--hg-bg-base, #050505);
  }

  .preview img {
    width: 110px;
    height: 110px;
    object-fit: contain;
  }

  .meta {
    display: grid;
    justify-items: start;
    gap: 6px;
    min-width: 0;
  }

  .source strong {
    color: var(--hg-text-primary, #f2efe7);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .meta .author {
    max-width: 100%;
    padding: 2px 0;
  }

  .ok {
    color: var(--hg-accent-green, #9be564);
  }

  .ghost,
  .add {
    min-height: 30px;
    padding: 0 10px;
    cursor: pointer;
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
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
    }

    .detail {
      grid-template-columns: 64px minmax(0, 1fr);
      align-items: center;
      gap: 8px 10px;
    }

    .preview {
      width: 64px;
      height: 64px;
    }

    .preview img {
      width: 48px;
      height: 48px;
    }

    .add, .detail-note {
      grid-column: 1 / -1;
    }
  }
</style>
