export declare class TTLCache<T> {
    private store;
    private defaultTTL;
    constructor(defaultTTLSeconds?: number);
    get(key: string): T | null;
    set(key: string, data: T, ttlSeconds?: number): void;
    clear(): void;
    get size(): number;
    prune(): number;
}
