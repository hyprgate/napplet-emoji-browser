import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorProfileResolver,
  fallbackAuthorIdentity,
  resolveAuthorIdentity,
  type AuthorIdentity,
} from './author-profiles.js';
import { common } from '@napplet/sdk';

vi.mock('@napplet/sdk', () => ({
  common: {
    getProfile: vi.fn(),
  },
}));

const PUBKEY = 'a'.repeat(64);

describe('author identity resolution (NAP-COMMON)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to a short npub-style label when no profile is known', () => {
    const fallback = fallbackAuthorIdentity(PUBKEY);
    expect(fallback.resolved).toBe(false);
    expect(fallback.picture).toBeNull();
    expect(fallback.label).toBe(`${PUBKEY.slice(0, 8)}…${PUBKEY.slice(-4)}`);
  });

  it('prefers displayName, then name, then nip05', async () => {
    vi.mocked(common.getProfile).mockResolvedValue({
      ok: true,
      pubkey: PUBKEY,
      profile: { displayName: 'Alice', name: 'alice', nip05: 'alice@example.com', picture: 'https://img/a.png' },
    });
    expect((await resolveAuthorIdentity(PUBKEY)).label).toBe('Alice');

    vi.mocked(common.getProfile).mockResolvedValue({
      ok: true,
      pubkey: PUBKEY,
      profile: { name: 'alice', nip05: 'alice@example.com' },
    });
    expect((await resolveAuthorIdentity(PUBKEY)).label).toBe('alice');

    vi.mocked(common.getProfile).mockResolvedValue({
      ok: true,
      pubkey: PUBKEY,
      profile: { nip05: 'alice@example.com' },
    });
    expect((await resolveAuthorIdentity(PUBKEY)).label).toBe('alice@example.com');
  });

  it('resolves avatar and marks resolved when a profile exists', async () => {
    vi.mocked(common.getProfile).mockResolvedValue({
      ok: true,
      pubkey: PUBKEY,
      profile: { displayName: 'Bob', picture: 'https://img/b.png' },
    });
    const identity = await resolveAuthorIdentity(PUBKEY);
    expect(identity.resolved).toBe(true);
    expect(identity.picture).toBe('https://img/b.png');
    expect(identity.label).toBe('Bob');
  });

  it('returns an unresolved npub fallback when the lookup throws or finds nothing', async () => {
    vi.mocked(common.getProfile).mockRejectedValue(new Error('relay down'));
    expect((await resolveAuthorIdentity(PUBKEY)).resolved).toBe(false);

    vi.mocked(common.getProfile).mockResolvedValue({ ok: true, pubkey: PUBKEY, profile: null });
    const empty = await resolveAuthorIdentity(PUBKEY);
    expect(empty.resolved).toBe(false);
    expect(empty.label).toBe(`${PUBKEY.slice(0, 8)}…${PUBKEY.slice(-4)}`);
  });

  it('dedupes concurrent lookups per pubkey and reports once', async () => {
    vi.mocked(common.getProfile).mockResolvedValue({
      ok: true,
      pubkey: PUBKEY,
      profile: { displayName: 'Carol' },
    });
    const resolved: AuthorIdentity[] = [];
    const resolver = createAuthorProfileResolver((identity) => resolved.push(identity));
    resolver.request(PUBKEY);
    resolver.request(PUBKEY);
    resolver.request(PUBKEY);
    await vi.waitFor(() => expect(resolved.length).toBe(1));
    expect(common.getProfile).toHaveBeenCalledTimes(1);
    expect(resolver.has(PUBKEY)).toBe(true);
  });
});
