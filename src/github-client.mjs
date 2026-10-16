/**
 * Minimal GitHub REST client (REST API, API version 2022-11-28). `fetchImpl` is injectable for tests.
 * Pagination follows the `Link: <...>; rel="next"` header (RFC 8288).
 */
export function createClient({ token, fetchImpl = globalThis.fetch, base = "https://api.github.com" }) {
  async function raw(method, path, body) {
    const response = await fetchImpl(path.startsWith("http") ? path : base + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "github-reconciliation-service",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return { data: null, response };
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`${method} ${path}: ${response.status} ${data?.message ?? ""}`.trim());
      error.status = response.status;
      throw error;
    }
    return { data, response };
  }
  return {
    request: async (method, path, body) => (await raw(method, path, body)).data,
    async paginate(path, { maxPages = 10 } = {}) {
      const items = [];
      let next = path + (path.includes("?") ? "&" : "?") + "per_page=100";
      for (let page = 0; next && page < maxPages; page += 1) {
        const { data, response } = await raw("GET", next);
        items.push(...(Array.isArray(data) ? data : data?.items ?? []));
        next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1] ?? null;
      }
      if (next) throw new RangeError("GitHub pagination incomplete: refuse a partial inventory");
      return items;
    },
  };
}
