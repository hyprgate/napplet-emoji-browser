<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `emoji-browser` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

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

## Paja runtime

```bash
pnpm --filter @hyprgate/napp-emoji-browser paja
```

This starts Kehto Paja and the napplet's Vite dev server together, using
the port configured in `vite.config.ts`.

## Testing

```bash
pnpm --filter @hyprgate/napp-emoji-browser test
pnpm --filter @hyprgate/napp-emoji-browser type-check
pnpm --filter @hyprgate/napp-emoji-browser build
```
