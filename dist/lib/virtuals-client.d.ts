import type { AgentRaw } from './scoring.js';
export declare class VirtualsApiError extends Error {
    readonly status: number;
    readonly endpoint: string;
    readonly retryable: boolean;
    constructor(message: string, status: number, endpoint: string, retryable: boolean);
}
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
export declare function fetchAgentsPage(page?: number, pageSize?: number, sort?: string): Promise<PaginatedResponse>;
export declare function fetchAgentByWallet(walletAddress: string): Promise<AgentRaw | null>;
export declare function fetchAgentById(documentId: string): Promise<AgentRaw | null>;
export declare function searchAgents(query: string, page?: number, pageSize?: number): Promise<PaginatedResponse>;
export {};
