// Virtuals Protocol API client — fetches raw agent data from acpx.virtuals.io
// v1.1.0 — Added retry with exponential backoff, structured errors, request logging
import type { AgentRaw } from './scoring.js';

const ACPX_BASE = 'https://acpx.virtuals.io/api';
const DEFAULT_TIMEOUT = 10_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500; // 500ms, 1000ms backoff

// ─── Error types ────────────────────────────────────────────────────

export class VirtualsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VirtualsApiError';
  }
}

// ─── Interfaces ─────────────────────────────────────────────────────

interface PaginatedResponse {
  data: AgentRaw[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

// ─── Retry-enabled fetch ────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  label: string,
  options: { retries?: number; timeout?: number } = {},
): Promise<Response> {
  const { retries = MAX_RETRIES, timeout = DEFAULT_TIMEOUT } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'Accept': 'application/json' },
      });

      // Don't retry client errors (400-499), only server errors
      if (res.ok) return res;

      const isRetryable = res.status >= 500 || res.status === 429;
      if (!isRetryable || attempt === retries) {
        throw new VirtualsApiError(
          `Virtuals API ${res.status}: ${res.statusText} [${label}]`,
          res.status,
          label,
          isRetryable,
        );
      }

      // Respect Retry-After header from 429 responses
      const retryAfter = res.headers.get('Retry-After');
      const delay = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 5000)
        : RETRY_BASE_MS * Math.pow(2, attempt);

      console.warn(`[VIRTUALS] ${label} → ${res.status}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
      await sleep(delay);
    } catch (err) {
      if (err instanceof VirtualsApiError) throw err;

      lastError = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      const isRetryable = code === 'ECONNABORTED' || code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED' || code === 'ECONNRESET' ||
        (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';

      if (!isRetryable || attempt === retries) {
        throw new VirtualsApiError(
          `Virtuals API network error: ${(err as Error).message} [${label}]`,
          0,
          label,
          isRetryable,
        );
      }

      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[VIRTUALS] ${label} → ${(err as Error).message}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error(`fetchWithRetry exhausted for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Public API ─────────────────────────────────────────────────────

export async function fetchAgentsPage(
  page: number = 1,
  pageSize: number = 25,
  sort: string = 'grossAgenticAmount:desc',
): Promise<PaginatedResponse> {
  const params = new URLSearchParams({
    'pagination[page]': page.toString(),
    'pagination[pageSize]': pageSize.toString(),
    sort,
  });

  const res = await fetchWithRetry(
    `${ACPX_BASE}/agents?${params}`,
    `fetchAgentsPage(p${page})`,
  );

  return await res.json() as PaginatedResponse;
}

export async function fetchAgentByWallet(walletAddress: string): Promise<AgentRaw | null> {
  const params = new URLSearchParams({
    'filters[walletAddress][$eqi]': walletAddress,
    'pagination[pageSize]': '1',
  });

  try {
    const res = await fetchWithRetry(
      `${ACPX_BASE}/agents?${params}`,
      `fetchAgentByWallet(${walletAddress.slice(0, 10)}...)`,
    );
    const data = await res.json() as PaginatedResponse;
    return data.data[0] || null;
  } catch (err) {
    if (err instanceof VirtualsApiError && err.status >= 400 && err.status < 500) {
      return null; // Agent not found is not an error
    }
    throw err;
  }
}

export async function fetchAgentById(documentId: string): Promise<AgentRaw | null> {
  const params = new URLSearchParams({
    'filters[documentId][$eq]': documentId,
    'pagination[pageSize]': '1',
  });

  try {
    const res = await fetchWithRetry(
      `${ACPX_BASE}/agents?${params}`,
      `fetchAgentById(${documentId})`,
    );
    const data = await res.json() as PaginatedResponse;
    return data.data[0] || null;
  } catch (err) {
    if (err instanceof VirtualsApiError && err.status >= 400 && err.status < 500) {
      return null;
    }
    throw err;
  }
}

export async function searchAgents(
  query: string,
  page: number = 1,
  pageSize: number = 25,
): Promise<PaginatedResponse> {
  const params = new URLSearchParams({
    'filters[$or][0][name][$containsi]': query,
    'filters[$or][1][symbol][$containsi]': query,
    'pagination[page]': page.toString(),
    'pagination[pageSize]': pageSize.toString(),
    'sort': 'grossAgenticAmount:desc',
  });

  const res = await fetchWithRetry(
    `${ACPX_BASE}/agents?${params}`,
    `searchAgents("${query}", p${page})`,
  );

  return await res.json() as PaginatedResponse;
}
