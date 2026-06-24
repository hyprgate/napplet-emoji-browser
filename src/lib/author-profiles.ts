import { common } from '@napplet/sdk';

export interface AuthorIdentity {
  pubkey: string;
  /** Best-effort display label: displayName > name > nip05 > short npub fallback. */
  label: string;
  /** Avatar URL when known. */
  picture: string | null;
  /** True once a kind-0 profile actually resolved (vs. the npub fallback). */
  resolved: boolean;
}

export type AuthorIdentityMap = Record<string, AuthorIdentity>;

function shortFallbackLabel(pubkey: string): string {
  return pubkey.length > 12 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : pubkey;
}

/** A non-resolved placeholder so the UI can render before metadata arrives. */
export function fallbackAuthorIdentity(pubkey: string): AuthorIdentity {
  return { pubkey, label: shortFallbackLabel(pubkey), picture: null, resolved: false };
}

function pickLabel(
  profile: { displayName?: string; name?: string; nip05?: string } | null | undefined,
  pubkey: string,
): string {
  const candidate = profile?.displayName?.trim()
    || profile?.name?.trim()
    || profile?.nip05?.trim();
  return candidate && candidate.length > 0 ? candidate : shortFallbackLabel(pubkey);
}

/**
 * Resolve an arbitrary author's identity through the runtime-supported shared
 * profile path (NAP-COMMON `common.getProfile`). Returns a best-effort identity:
 * the resolved kind-0 display name + avatar when available, or an npub-style
 * fallback label otherwise. Never throws.
 */
export async function resolveAuthorIdentity(pubkey: string): Promise<AuthorIdentity> {
  try {
    const result = await common.getProfile(pubkey);
    const profile = result?.profile ?? null;
    return {
      pubkey,
      label: pickLabel(profile, pubkey),
      picture: typeof profile?.picture === 'string' && profile.picture.length > 0 ? profile.picture : null,
      resolved: Boolean(result?.ok && profile),
    };
  } catch {
    return fallbackAuthorIdentity(pubkey);
  }
}

/**
 * Per-pubkey deduping resolver. `request(pubkey)` resolves at most one in-flight
 * lookup per pubkey and reports the result through `onResolved`. Already-resolved
 * pubkeys are skipped.
 */
export function createAuthorProfileResolver(
  onResolved: (identity: AuthorIdentity) => void,
): { request(pubkey: string): void; has(pubkey: string): boolean } {
  const inflight = new Set<string>();
  const done = new Set<string>();
  return {
    has: (pubkey) => done.has(pubkey),
    request(pubkey: string): void {
      if (!pubkey || inflight.has(pubkey) || done.has(pubkey)) return;
      inflight.add(pubkey);
      void resolveAuthorIdentity(pubkey).then((identity) => {
        inflight.delete(pubkey);
        done.add(pubkey);
        onResolved(identity);
      });
    },
  };
}
