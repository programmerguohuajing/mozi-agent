/**
 * 网络白名单（M6 §6.4 网络代理）：判断出站域名是否放行。
 * 简化实现：纯字符串匹配 + 后缀匹配（含「*.」通配）。真实 L2/L3 由本地代理按此表放行。
 */

const DEFAULT_ALLOW_NET = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'api.github.com',
];

/** 默认放行的包管理 / 代码托管域名。 */
export function defaultAllowNet(): string[] {
  return [...DEFAULT_ALLOW_NET];
}

/**
 * 判断 hostname 是否命中白名单。
 * 支持精确匹配与通配：白名单项 `*.npmjs.org` 匹配 `a.npmjs.org`，`npmjs.org` 同时匹配自身与子域。
 */
export function isNetworkAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  for (const raw of allowlist) {
    const entry = raw.toLowerCase().trim();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry === host) return true;
    // 「*.example.com」匹配任意子域（不含 example.com 自身，除非同时列出）
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      if (host.endsWith(`.${base}`)) return true;
    }
    // 不带通配的裸域名，放行其自身及所有子域
    if (!entry.includes('*') && (host === entry || host.endsWith(`.${entry}`))) {
      return true;
    }
  }
  return false;
}

/** 把用户 --allow-net 追加到默认表（去重 + 归一化小写，保证后续匹配一致）。 */
export function mergeAllowNet(extra?: string[]): string[] {
  if (!extra || extra.length === 0) return defaultAllowNet();
  const normalized = extra
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return [...new Set([...defaultAllowNet(), ...normalized])];
}
