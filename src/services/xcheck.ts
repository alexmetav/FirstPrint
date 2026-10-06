/**
 * Checks on X (Twitter) through GetXAPI (https://docs.getxapi.com), a pay-per-call X data API:
 * whether a player owns the X username they linked, follows an account, reposted a post, or posted
 * their invite link. Each call costs about $0.001; the key (GETXAPI_KEY) lives only in the host's
 * settings. Likes can't be checked this way (they need the player's own X login), so like tasks stay
 * honour-based.
 */

/** X couldn't be checked just now (network, GetXAPI down, or out of credit). Never means "not done". */
export class XCheckUnavailable extends Error {}

export interface XProfile {
  userName: string;
  description: string;
}

export interface XPost {
  text: string;
  createdAt: number;
}

export interface XChecker {
  /** The profile, or null when there is no such X account. */
  profile(userName: string): Promise<XProfile | null>;
  /** True when `source` follows `target`. */
  follows(source: string, target: string): Promise<boolean>;
  /** True when `userName` reposted the post (looks through the most recent reposters). */
  reposted(userName: string, tweetId: string): Promise<boolean>;
  /** The account's most recent posts (about 20), newest first. */
  recentPosts(userName: string): Promise<XPost[]>;
  /** Credit left on the GetXAPI account, in dollars (a free call), or null if it can't be read. */
  credit(): Promise<number | null>;
}

const BASE = 'https://api.getxapi.com';
/** How many pages of reposters (about 20 each) a repost check reads at most. */
const REPOST_PAGES = 5;

export class GetXApi implements XChecker {
  private key: string;
  private fetchImpl: typeof fetch;

  constructor(key: string, fetchImpl: typeof fetch = fetch) {
    this.key = key.trim();
    this.fetchImpl = fetchImpl;
  }

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new XCheckUnavailable(`GetXAPI unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new XCheckUnavailable(`GetXAPI ${path} answered ${res.status}: ${text.slice(0, 160)}`);
    return body;
  }

  async profile(userName: string): Promise<XProfile | null> {
    const body = await this.get('/twitter/user/info', { userName });
    const d = body.data as { userName?: string; description?: string } | undefined;
    if (body.notFound || !d?.userName) return null;
    return { userName: d.userName, description: String(d.description ?? '') };
  }

  async follows(source: string, target: string): Promise<boolean> {
    const body = await this.get('/twitter/user/check_follow_relationship', { source_user_name: source, target_user_name: target });
    const d = body.data as { sourceFollowsTarget?: boolean } | undefined;
    if (body.notFound || !d) return false;
    return d.sourceFollowsTarget === true;
  }

  async reposted(userName: string, tweetId: string): Promise<boolean> {
    const want = userName.toLowerCase();
    let cursor = '';
    for (let page = 0; page < REPOST_PAGES; page++) {
      const body = await this.get('/twitter/tweet/retweeters', cursor ? { id: tweetId, cursor } : { id: tweetId });
      if (body.notFound) return false;
      const users = (body.users as { userName?: string }[] | undefined) ?? [];
      if (users.some((u) => String(u.userName ?? '').toLowerCase() === want)) return true;
      cursor = String(body.next_cursor ?? '');
      if (!body.has_more || !cursor) return false;
    }
    return false;
  }

  async recentPosts(userName: string): Promise<XPost[]> {
    const body = await this.get('/twitter/user/tweets', { userName });
    if (body.notFound) return [];
    return ((body.tweets as { text?: string; createdAt?: string }[] | undefined) ?? []).map((t) => ({
      text: String(t.text ?? ''),
      createdAt: Date.parse(String(t.createdAt ?? '')) || 0,
    }));
  }

  async credit(): Promise<number | null> {
    try {
      const body = await this.get('/account/me', {});
      const n = Number(body.balance_total ?? body.credits_remaining);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
}
