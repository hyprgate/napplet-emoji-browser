<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `emoji-browser` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Emoji Browser

Discover custom emoji from the people you follow, grouped by arrival, pack or person,
and add the ones you like to your quick-react list.

The source lives in the Hyprgate monorepo at `napplets/emoji-browser`. The standalone
`hyprgate/napplet-emoji-browser` repository is a generated, read-only mirror, so send
changes to [hyprgate/web](https://github.com/hyprgate/web).

## Developing

Run these from the root of a Hyprgate checkout so workspace dependencies resolve:

```bash
pnpm install --frozen-lockfile
pnpm --filter ./napplets/emoji-browser paja        # Kehto Paja plus the Vite dev server
pnpm --filter ./napplets/emoji-browser test
pnpm --filter ./napplets/emoji-browser type-check
pnpm --filter ./napplets/emoji-browser build
```
