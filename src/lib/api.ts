export const api = {
  async get(path: string) {
    const response = await fetch(path, { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error((data as any)?.error || `HTTP ${response.status}`), { response, data });
    return { data: data as any };
  },
  async post(path: string, body?: unknown) {
    const response = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error((data as any)?.error || `HTTP ${response.status}`), { response, data });
    return { data: data as any };
  },
};

export const ws = {
  connect() {
    const listeners: Array<(message: unknown) => void> = [];
    return {
      connectionId: crypto.randomUUID(),
      ready: Promise.resolve(),
      onMessage(fn: (message: unknown) => void) { listeners.push(fn); },
      onError(_fn: (error: unknown) => void) {},
      disconnect() { listeners.length = 0; },
    };
  },
};
