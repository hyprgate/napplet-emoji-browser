# napplet-emoji-browser

Forkable source repository for the Hyprgate built-in Emoji Browser napplet, packaged as `@hyprgate/napp-emoji-browser`.

This repository is mounted into the Hyprgate parent checkout as `napplets/emoji-browser`.
It expects the parent workspace for shared `@hyprgate/*` packages.

## Parent checkout

```bash
git clone --recurse-submodules git@github.com:hyprgate/gui.git
cd gui
pnpm install --frozen-lockfile
pnpm --filter @hyprgate/napp-emoji-browser build
```

## Testing

```bash
pnpm --filter @hyprgate/napp-emoji-browser test
pnpm --filter @hyprgate/napp-emoji-browser type-check
pnpm --filter @hyprgate/napp-emoji-browser build
```
