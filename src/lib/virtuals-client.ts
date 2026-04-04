// Virtuals Protocol API client — fetches raw agent data from acpx.virtuals.io
import type { AgentRaw } from './scoring.js';

const ACPX_BASE = 'https://acpx.virtuals.io/api';
const DEFAULT_TIMEOUT = 10_000;

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

  const res = await fetch(`${ACPX_BASE}/agents?${params}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Virtuals API error: ${res.status} ${res.statusText}`);
  }

  return await res.json() as PaginatedResponse;
}

export async function fetchAgentByWallet(walletAddress: string): Promise<AgentRaw | null> {
  const params = new URLSearchParams({
    'filters[walletAddress][$eqi]': walletAddress,
    'pagination[pageSize]': '1',
  });

  const res = await fetch(`${ACPX_BASE}/agents?${params}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) return null;
  const data = await res.json() as PaginatedResponse;
  return data.data[0] || null;
}

export async function fetchAgentById(documentId: string): Promise<AgentRaw | null> {
  const params = new URLSearchParams({
    'filters[documentId][$eq]': documentId,
    'pagination[pageSize]': '1',
  });

  const res = await fetch(`${ACPX_BASE}/agents?${params}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) return null;
  const data = await res.json() as PaginatedResponse;
  return data.data[0] || null;
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

  const res = await fetch(`${ACPX_BASE}/agents?${params}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Virtuals API error: ${res.status} ${res.statusText}`);
  }

  return await res.json() as PaginatedResponse;
}
