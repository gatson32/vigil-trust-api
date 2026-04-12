// Simple in-memory TTL cache for API responses
// Prevents hammering acpx.virtuals.io on every request
export class TTLCache {
    store = new Map();
    defaultTTL;
    constructor(defaultTTLSeconds = 300) {
        this.defaultTTL = defaultTTLSeconds * 1000;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.data;
    }
    set(key, data, ttlSeconds) {
        const ttl = (ttlSeconds ?? this.defaultTTL / 1000) * 1000;
        this.store.set(key, {
            data,
            expiresAt: Date.now() + ttl,
        });
    }
    clear() {
        this.store.clear();
    }
    get size() {
        return this.store.size;
    }
    // Prune expired entries
    prune() {
        const now = Date.now();
        let pruned = 0;
        for (const [key, entry] of this.store) {
            if (now > entry.expiresAt) {
                this.store.delete(key);
                pruned++;
            }
        }
        return pruned;
    }
}
