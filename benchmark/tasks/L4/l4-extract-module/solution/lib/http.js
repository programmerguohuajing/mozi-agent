export async function httpGet(url) {
  return { method: 'GET', url };
}

export async function httpPost(url, body) {
  return { method: 'POST', url, body };
}
