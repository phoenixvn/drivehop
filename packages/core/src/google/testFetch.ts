// Test helper (not exported from the package): a scripted `fetch` that records every request.

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** Request body as text (JSON / form), or bytes for uploads. */
  body: string | Uint8Array | undefined;
  redirect: RequestInit['redirect'];
}

export type Handler = (req: RecordedRequest) => Response | Promise<Response>;

export interface ScriptedFetch {
  fetch: typeof fetch;
  calls: RecordedRequest[];
  /** Queues a one-shot handler; queued handlers run in order before the fallback. */
  once(handler: Handler): void;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function driveError(status: number, reason: string, message = 'error'): Response {
  return json(status, { error: { code: status, message, errors: [{ reason, message }] } });
}

/** `fallback` answers every request no queued handler took. */
export function scriptedFetch(fallback?: Handler): ScriptedFetch {
  const queue: Handler[] = [];
  const calls: RecordedRequest[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let body: string | Uint8Array | undefined;
    const raw = init?.body;
    if (typeof raw === 'string') body = raw;
    else if (raw instanceof Uint8Array) body = new Uint8Array(raw);
    else if (raw instanceof URLSearchParams) body = raw.toString();
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers as Record<string, string> | undefined),
      body,
      redirect: init?.redirect,
    };
    calls.push(req);
    const handler = queue.shift() ?? fallback;
    if (handler === undefined) throw new Error(`unexpected request ${req.method} ${url.pathname}`);
    return handler(req);
  };
  return { fetch: fn as typeof fetch, calls, once: (handler) => queue.push(handler) };
}
