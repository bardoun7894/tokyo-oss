function getToken(): string {
  return window.__TOKEN__ ?? "";
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  };
}

export async function api<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function postApi<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function patchApi<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function deleteApi<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
