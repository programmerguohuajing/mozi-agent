/**
 * OAuth 2.1 + PKCE（M8 §8.3.3）：授权码流程的客户端实现。
 * 浏览器打开与本地回调步骤通过可注入回调解耦（CLI 与桌面各自实现），
 * 本模块负责 PKCE 生成、元数据发现、token 换发/刷新与持久化接口。
 */
import { randomBytes, createHash } from 'node:crypto';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
}

/** 令牌持久化（safeStorage 加密落盘由宿主实现，本模块只定义接口）。 */
export interface TokenStore {
  load(serverId: string): Promise<TokenSet | undefined>;
  save(serverId: string, token: TokenSet): Promise<void>;
  clear(serverId: string): Promise<void>;
}

const MEMORY = new Map<string, TokenSet>();

export class MemoryTokenStore implements TokenStore {
  async load(serverId: string): Promise<TokenSet | undefined> {
    return MEMORY.get(serverId);
  }
  async save(serverId: string, token: TokenSet): Promise<void> {
    MEMORY.set(serverId, token);
  }
  async clear(serverId: string): Promise<void> {
    MEMORY.delete(serverId);
  }
}

export interface OAuthCallbacks {
  /** 打开系统浏览器到给定 URL；用户授权后回调携带 code。 */
  openBrowser(url: string): Promise<string>; // 返回授权码
  /** 本地回调服务不可用时的降级：手动粘贴 code。 */
  promptCode?(): Promise<string>;
}

export function genPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 解析 RFC 9728 保护资源元数据（简化：取首个 authorization server 的 issuer）。 */
export async function discoverAuthServer(resourceUrl: string): Promise<string | undefined> {
  try {
    const metaUrl = new URL('/.well-known/oauth-protected-resource', resourceUrl).href;
    const res = await fetch(metaUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return undefined;
    const meta = (await res.json()) as { authorization_servers?: string[] };
    return meta.authorization_servers?.[0];
  } catch {
    return undefined;
  }
}

export class OAuthFlow {
  private verifier?: string;
  constructor(
    private serverId: string,
    private authServer: string,
    private redirectUri: string,
    private store: TokenStore,
    private cb: OAuthCallbacks,
  ) {}

  /** 生成授权 URL（携带 PKCE）。 */
  buildAuthorizeUrl(state: string, challenge: string, scope = 'mcp'): string {
    const u = new URL(`${this.authServer}/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', 'mozi-client');
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    u.searchParams.set('scope', scope);
    return u.href;
  }

  /** 执行完整授权流，返回可用的 access token（含自动刷新）。 */
  async authorize(host: string): Promise<string> {
    const cached = await this.store.load(this.serverId);
    if (cached?.accessToken && (cached.expiresAt ?? 0) > Date.now() + 30_000) {
      return cached.accessToken;
    }
    if (cached?.refreshToken) {
      try {
        return await this.refresh(cached.refreshToken);
      } catch {
        /* 刷新失败 → 重新走授权流 */
      }
    }
    const { verifier, challenge } = genPkce();
    this.verifier = verifier;
    const state = randomBytes(8).toString('hex');
    const url = this.buildAuthorizeUrl(state, challenge);
    const code = await this.cb.openBrowser(url).catch(async () => this.cb.promptCode?.() ?? '');
    if (!code) throw new Error('oauth: no authorization code');
    return this.exchange(code);
  }

  private async exchange(code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: this.verifier ?? '',
      client_id: 'mozi-client',
      redirect_uri: this.redirectUri,
    });
    const res = await fetch(`${this.authServer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`oauth token error: ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const set: TokenSet = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
      scope: json.scope,
    };
    await this.store.save(this.serverId, set);
    return set.accessToken;
  }

  private async refresh(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'mozi-client',
    });
    const res = await fetch(`${this.authServer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('refresh failed');
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const cached = (await this.store.load(this.serverId)) ?? { accessToken: json.access_token };
    const set: TokenSet = {
      ...cached,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? cached.refreshToken,
      expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : cached.expiresAt,
    };
    await this.store.save(this.serverId, set);
    return set.accessToken;
  }
}
