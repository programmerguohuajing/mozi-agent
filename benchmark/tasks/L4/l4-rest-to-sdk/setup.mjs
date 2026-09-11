// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'sdk'), { recursive: true });
mkdirSync(join(dir, 'api'), { recursive: true });

writeFileSync(
  join(dir, 'sdk', 'index.js'),
  `/**
 * 新 SDK：资源客户端基类。统一 URL 拼接与鉴权头。
 */
export class ResourceClient {
  constructor({ baseUrl, token, resource }) {
    this.baseUrl = baseUrl.replace(/\\/$/, '');
    this.token = token;
    this.resource = resource;
  }

  async #request(method, path, body) {
    const res = await fetch(this.baseUrl + '/' + this.resource + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  get(path) {
    return this.#request('GET', path);
  }
  post(path, body) {
    return this.#request('POST', path, body);
  }
  put(path, body) {
    return this.#request('PUT', path, body);
  }
  del(path) {
    return this.#request('DELETE', path, undefined);
  }
}
`,
);

writeFileSync(
  join(dir, 'api', 'client.js'),
  `const BASE_URL = 'https://api.example.com/v1';
const TOKEN = 'tok_123';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

// TODO: 迁移到 sdk/index.js 的 ResourceClient（行为必须不变）
export function getUser(id) {
  return request('GET', BASE_URL + '/users/' + id);
}

export function listUsers() {
  return request('GET', BASE_URL + '/users');
}

export function createOrder(payload) {
  return request('POST', BASE_URL + '/orders', payload);
}

export function updateOrder(id, payload) {
  return request('PUT', BASE_URL + '/orders/' + id, payload);
}
`,
);
