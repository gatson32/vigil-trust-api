const ACPX_BASE = 'https://acpx.virtuals.io/api';
const DEFAULT_TIMEOUT = 10_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500; // 500ms, 1000ms backoff
// ─── Error types ────────────────────────────────────────────────────
export class VirtualsApiError extends Error {
    status;
    endpoint;
    retryable;
    constructor(message, status, endpoint, retryable) {
        super(message);
        this.status = status;
        this.endpoint = endpoint;
        this.retryable = retryable;
        this.name = 'VirtualsApiError';
    }
}
// ─── Retry-enabled fetch ────────────────────────────────────────────
async function fetchWithRetry(url, label, options = {}) {
    const { retries = MAX_RETRIES, timeout = DEFAULT_TIMEOUT } = options;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(timeout),
                headers: { 'Accept': 'application/json' },
            });
            // Don't retry client errors (400-499), only server errors
            if (res.ok)
                return res;
            const isRetryable = res.status >= 500 || res.status === 429;
            if (!isRetryable || attempt === retries) {
                throw new VirtualsApiError(`Virtuals API ${res.status}: ${res.statusText} [${label}]`, res.status, label, isRetryable);
            }
            // Respect Retry-After header from 429 responses
            const retryAfter = res.headers.get('Retry-After');
            const delay = retryAfter
                ? Math.min(parseInt(retryAfter, 10) * 1000, 5000)
                : RETRY_BASE_MS * Math.pow(2, attempt);
            console.warn(`[VIRTUALS] ${label} → ${res.status}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
            await sleep(delay);
        }
        catch (err) {
            if (err instanceof VirtualsApiError)
                throw err;
            lastError = err;
            const code = err.code;
            const isRetryable = code === 'ECONNABORTED' || code === 'ETIMEDOUT' ||
                code === 'ECONNREFUSED' || code === 'ECONNRESET' ||
                err.name === 'TimeoutError' || err.name === 'AbortError';
            if (!isRetryable || attempt === retries) {
                throw new VirtualsApiError(`Virtuals API network error: ${err.message} [${label}]`, 0, label, isRetryable);
            }
            const delay = RETRY_BASE_MS * Math.pow(2, attempt);
            console.warn(`[VIRTUALS] ${label} → ${err.message}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
            await sleep(delay);
        }
    }
    // Should never reach here, but TypeScript needs it
    throw lastError || new Error(`fetchWithRetry exhausted for ${label}`);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ─── Public API ─────────────────────────────────────────────────────
export async function fetchAgentsPage(page = 1, pageSize = 25, sort = 'grossAgenticAmount:desc') {
    const params = new URLSearchParams({
        'pagination[page]': page.toString(),
        'pagination[pageSize]': pageSize.toString(),
        sort,
    });
    const res = await fetchWithRetry(`${ACPX_BASE}/agents?${params}`, `fetchAgentsPage(p${page})`);
    return await res.json();
}
export async function fetchAgentByWallet(walletAddress) {
    const params = new URLSearchParams({
        'filters[walletAddress][$eqi]': walletAddress,
        'pagination[pageSize]': '1',
    });
    try {
        const res = await fetchWithRetry(`${ACPX_BASE}/agents?${params}`, `fetchAgentByWallet(${walletAddress.slice(0, 10)}...)`);
        const data = await res.json();
        return data.data[0] || null;
    }
    catch (err) {
        if (err instanceof VirtualsApiError && err.status >= 400 && err.status < 500) {
            return null; // Agent not found is not an error
        }
        throw err;
    }
}
export async function fetchAgentById(documentId) {
    const params = new URLSearchParams({
        'filters[documentId][$eq]': documentId,
        'pagination[pageSize]': '1',
    });
    try {
        const res = await fetchWithRetry(`${ACPX_BASE}/agents?${params}`, `fetchAgentById(${documentId})`);
        const data = await res.json();
        return data.data[0] || null;
    }
    catch (err) {
        if (err instanceof VirtualsApiError && err.status >= 400 && err.status < 500) {
            return null;
        }
        throw err;
    }
}
export async function searchAgents(query, page = 1, pageSize = 25) {
    const params = new URLSearchParams({
        'filters[$or][0][name][$containsi]': query,
        'filters[$or][1][symbol][$containsi]': query,
        'pagination[page]': page.toString(),
        'pagination[pageSize]': pageSize.toString(),
        'sort': 'grossAgenticAmount:desc',
    });
    const res = await fetchWithRetry(`${ACPX_BASE}/agents?${params}`, `searchAgents("${query}", p${page})`);
    return await res.json();
}
