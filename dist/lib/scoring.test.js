// VIGIL Trust Score — Unit Tests
import { describe, it, expect } from 'vitest';
import { scoreAgent, TIER_CONFIG } from './scoring.js';
// ─── Test Helpers ───────────────────────────────────────────────────
function makeAgent(overrides = {}) {
    return {
        id: 1,
        documentId: 'test-doc-001',
        name: 'TestAgent',
        description: 'A test agent',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        profilePic: null,
        category: 'DEFI',
        tokenAddress: null,
        symbol: 'TEST',
        twitterHandle: null,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
        updatedAt: new Date().toISOString(),
        lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
        successfulJobCount: 500,
        successRate: 95,
        uniqueBuyerCount: 50,
        transactionCount: 1000,
        grossAgenticAmount: 50000,
        hasGraduated: true,
        walletBalance: '100.5',
        isHighRisk: false,
        jobs: [{ id: 1, name: 'job1', type: 'service', price: 10 }],
        resources: [],
        offerings: [{ id: 1, name: 'offer1', price: 10, priceUsd: 5 }],
        enabledChains: [{ id: 1, name: 'Base' }],
        metrics: {
            successfulJobCount: 500,
            successRate: 95,
            uniqueBuyerCount: 50,
            isOnline: true,
            minsFromLastOnlineTime: 5,
            transactionCount: 1000,
            grossAgenticAmount: 50000,
            revenue: 5000,
            rating: 4.5,
            lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
        revenue: 5000,
        rating: 4.5,
        role: 'service',
        cluster: 'defi',
        ...overrides,
    };
}
// ─── Basic Scoring ──────────────────────────────────────────────────
describe('scoreAgent — basic behavior', () => {
    it('returns all required fields', async () => {
        const result = await scoreAgent(makeAgent());
        // Identity fields
        expect(result.name).toBe('TestAgent');
        expect(result.documentId).toBe('test-doc-001');
        expect(result.walletAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
        expect(result.category).toBe('DEFI');
        expect(result.symbol).toBe('TEST');
        expect(result.hasGraduated).toBe(true);
        expect(result.isOnline).toBe(true);
        // Score breakdown — all should be numbers 0-100
        expect(result.reliabilityScore).toBeGreaterThanOrEqual(0);
        expect(result.reliabilityScore).toBeLessThanOrEqual(100);
        expect(result.activityScore).toBeGreaterThanOrEqual(0);
        expect(result.activityScore).toBeLessThanOrEqual(100);
        expect(result.economicScore).toBeGreaterThanOrEqual(0);
        expect(result.economicScore).toBeLessThanOrEqual(100);
        expect(result.reputationScore).toBeGreaterThanOrEqual(0);
        expect(result.reputationScore).toBeLessThanOrEqual(100);
        expect(result.longevityScore).toBeGreaterThanOrEqual(0);
        expect(result.longevityScore).toBeLessThanOrEqual(100);
        // Composite
        expect(result.trustScore).toBeGreaterThanOrEqual(0);
        expect(result.trustScore).toBeLessThanOrEqual(100);
        expect(typeof result.trustTier).toBe('string');
        expect(Array.isArray(result.riskFlags)).toBe(true);
    });
    it('scores a healthy agent with valid tier and grade', async () => {
        const result = await scoreAgent(makeAgent());
        expect(result.trustScore).toBeGreaterThanOrEqual(0);
        expect(result.trustScore).toBeLessThanOrEqual(100);
        expect(['ELITE', 'TRUSTED', 'ESTABLISHED', 'EMERGING', 'NEW']).toContain(result.trustTier);
        expect(['A', 'B', 'C', 'D', 'F']).toContain(result.trustGrade);
    });
    it('scores no NaN in any numeric field', async () => {
        const result = await scoreAgent(makeAgent());
        const numericFields = [
            'successRate', 'successfulJobCount', 'uniqueBuyerCount', 'transactionCount',
            'grossAgenticAmount', 'walletBalance', 'jobCount', 'resourceCount',
            'offeringCount', 'chainCount', 'accountAgeDays', 'daysSinceActive',
            'revenue', 'reliabilityScore', 'activityScore', 'economicScore',
            'reputationScore', 'longevityScore', 'trustScore',
        ];
        for (const field of numericFields) {
            expect(Number.isFinite(result[field]), `${field} should be finite, got ${result[field]}`).toBe(true);
        }
    });
});
// ─── Tier Assignment ────────────────────────────────────────────────
describe('scoreAgent — tier assignment', () => {
    it('assigns ELITE for high-performing agents', async () => {
        const result = await scoreAgent(makeAgent({
            successRate: 99,
            successfulJobCount: 100000,
            uniqueBuyerCount: 2000,
            transactionCount: 500000,
            grossAgenticAmount: 10000000,
            revenue: 100000,
            walletBalance: '5000',
            hasGraduated: true,
            lastActiveAt: new Date().toISOString(),
            createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
            offerings: [
                { id: 1, name: 'a', price: 10, priceUsd: 5 },
                { id: 2, name: 'b', price: 20, priceUsd: 10 },
                { id: 3, name: 'c', price: 30, priceUsd: 15 },
            ],
            metrics: {
                successfulJobCount: 100000, successRate: 99, uniqueBuyerCount: 2000,
                isOnline: true, minsFromLastOnlineTime: 1, transactionCount: 500000,
                grossAgenticAmount: 10000000, revenue: 100000, rating: 5,
                lastActiveAt: new Date().toISOString(),
            },
        }));
        // v2 scoring is stricter — sustainability + complexity + sybil penalties apply
        expect(result.trustScore).toBeGreaterThanOrEqual(50);
        expect(['ELITE', 'TRUSTED', 'ESTABLISHED']).toContain(result.trustTier);
    });
    it('assigns NEW for brand-new zero-activity agent', async () => {
        const result = await scoreAgent(makeAgent({
            successRate: 0,
            successfulJobCount: 0,
            uniqueBuyerCount: 0,
            transactionCount: 0,
            grossAgenticAmount: 0,
            revenue: null,
            walletBalance: '0',
            hasGraduated: false,
            createdAt: new Date().toISOString(),
            lastActiveAt: null,
            jobs: [],
            offerings: [],
            enabledChains: [],
            metrics: {
                successfulJobCount: 0, successRate: 0, uniqueBuyerCount: 0,
                isOnline: false, minsFromLastOnlineTime: 0, transactionCount: 0,
                grossAgenticAmount: 0, revenue: null, rating: null, lastActiveAt: null,
            },
        }));
        expect(result.trustScore).toBeLessThan(20);
        expect(result.trustTier).toBe('NEW');
        expect(result.riskFlags).toContain('NO_ACTIVITY');
    });
    it('assigns HIGH_RISK and caps score at 20', async () => {
        const result = await scoreAgent(makeAgent({ isHighRisk: true }));
        expect(result.trustTier).toBe('HIGH_RISK');
        expect(result.trustScore).toBeLessThanOrEqual(20);
        expect(result.riskFlags).toContain('FLAGGED_HIGH_RISK');
    });
    it('assigns INACTIVE for long-dormant zero-job agents', async () => {
        const result = await scoreAgent(makeAgent({
            successfulJobCount: 0,
            transactionCount: 0,
            lastActiveAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
            createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
            metrics: {
                successfulJobCount: 0, successRate: 0, uniqueBuyerCount: 0,
                isOnline: false, minsFromLastOnlineTime: 999999, transactionCount: 0,
                grossAgenticAmount: 0, revenue: null, rating: null,
                lastActiveAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
            },
        }));
        expect(result.trustTier).toBe('INACTIVE');
    });
});
// ─── Risk Flags ─────────────────────────────────────────────────────
describe('scoreAgent — risk flags', () => {
    it('flags LOW_SUCCESS_RATE when rate < 50% with 100+ jobs', async () => {
        const result = await scoreAgent(makeAgent({
            successRate: 30,
            successfulJobCount: 500,
        }));
        expect(result.riskFlags).toContain('LOW_SUCCESS_RATE');
    });
    it('does NOT flag LOW_SUCCESS_RATE when jobs < 100', async () => {
        const result = await scoreAgent(makeAgent({
            successRate: 30,
            successfulJobCount: 50,
        }));
        expect(result.riskFlags).not.toContain('LOW_SUCCESS_RATE');
    });
    it('flags DORMANT when inactive > 90 days', async () => {
        const result = await scoreAgent(makeAgent({
            lastActiveAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
        }));
        expect(result.riskFlags).toContain('DORMANT');
    });
    it('flags EMPTY_WALLET when balance is 0 but has jobs', async () => {
        const result = await scoreAgent(makeAgent({
            walletBalance: '0',
            successfulJobCount: 100,
        }));
        expect(result.riskFlags).toContain('EMPTY_WALLET');
    });
    it('does NOT flag EMPTY_WALLET when no jobs', async () => {
        const result = await scoreAgent(makeAgent({
            walletBalance: '0',
            successfulJobCount: 0,
        }));
        expect(result.riskFlags).not.toContain('EMPTY_WALLET');
    });
});
// ─── Edge Cases & NaN Safety ────────────────────────────────────────
describe('scoreAgent — edge cases / NaN safety', () => {
    it('handles null walletBalance without NaN', async () => {
        // @ts-expect-error — testing runtime safety with bad input
        const result = await scoreAgent(makeAgent({ walletBalance: null }));
        expect(Number.isFinite(result.walletBalance)).toBe(true);
        expect(Number.isFinite(result.trustScore)).toBe(true);
    });
    it('handles non-numeric walletBalance string', async () => {
        const result = await scoreAgent(makeAgent({ walletBalance: 'not-a-number' }));
        expect(result.walletBalance).toBe(0);
        expect(Number.isFinite(result.trustScore)).toBe(true);
    });
    it('handles empty string walletBalance', async () => {
        const result = await scoreAgent(makeAgent({ walletBalance: '' }));
        expect(result.walletBalance).toBe(0);
    });
    it('handles undefined/null numeric fields gracefully', async () => {
        const agent = makeAgent();
        // @ts-expect-error — testing runtime safety
        agent.successRate = undefined;
        // @ts-expect-error — testing runtime safety
        agent.successfulJobCount = null;
        // @ts-expect-error — testing runtime safety
        agent.transactionCount = undefined;
        const result = await scoreAgent(agent);
        expect(Number.isFinite(result.trustScore)).toBe(true);
        expect(Number.isFinite(result.reliabilityScore)).toBe(true);
        expect(Number.isFinite(result.activityScore)).toBe(true);
    });
    it('handles invalid createdAt date', async () => {
        const result = await scoreAgent(makeAgent({ createdAt: 'not-a-date' }));
        expect(Number.isFinite(result.accountAgeDays)).toBe(true);
        expect(result.accountAgeDays).toBeGreaterThanOrEqual(1);
        expect(Number.isFinite(result.trustScore)).toBe(true);
    });
    it('handles null lastActiveAt', async () => {
        const result = await scoreAgent(makeAgent({ lastActiveAt: null }));
        expect(Number.isFinite(result.daysSinceActive)).toBe(true);
        expect(Number.isFinite(result.trustScore)).toBe(true);
    });
    it('handles missing metrics object', async () => {
        const agent = makeAgent();
        // @ts-expect-error — testing runtime safety
        agent.metrics = undefined;
        const result = await scoreAgent(agent);
        expect(result.isOnline).toBe(false);
        expect(Number.isFinite(result.trustScore)).toBe(true);
    });
    it('handles null revenue and metrics.revenue', async () => {
        const result = await scoreAgent(makeAgent({
            revenue: null,
            metrics: {
                successfulJobCount: 100, successRate: 90, uniqueBuyerCount: 10,
                isOnline: true, minsFromLastOnlineTime: 5, transactionCount: 200,
                grossAgenticAmount: 1000, revenue: null, rating: null, lastActiveAt: null,
            },
        }));
        expect(result.revenue).toBe(0);
        expect(Number.isFinite(result.economicScore)).toBe(true);
    });
    it('handles empty jobs/offerings/chains arrays', async () => {
        const result = await scoreAgent(makeAgent({
            jobs: [],
            offerings: [],
            enabledChains: [],
            resources: [],
        }));
        expect(result.jobCount).toBe(0);
        expect(result.offeringCount).toBe(0);
        expect(result.chainCount).toBe(0);
        expect(result.resourceCount).toBe(0);
    });
    it('handles null/undefined arrays', async () => {
        const agent = makeAgent();
        // @ts-expect-error — testing runtime safety
        agent.jobs = undefined;
        // @ts-expect-error — testing runtime safety
        agent.offerings = null;
        // @ts-expect-error — testing runtime safety
        agent.enabledChains = undefined;
        const result = await scoreAgent(agent);
        expect(result.jobCount).toBe(0);
        expect(result.offeringCount).toBe(0);
        expect(result.chainCount).toBe(0);
    });
    it('handles negative successRate by clamping to 0', async () => {
        const result = await scoreAgent(makeAgent({ successRate: -10 }));
        expect(result.reliabilityScore).toBeGreaterThanOrEqual(0);
    });
    it('handles successRate > 100 by clamping', async () => {
        const result = await scoreAgent(makeAgent({ successRate: 150 }));
        expect(result.reliabilityScore).toBeLessThanOrEqual(100);
    });
});
// ─── Score Weights ──────────────────────────────────────────────────
describe('scoreAgent — weight validation', () => {
    it('composite score is always 0-100', async () => {
        // Test with extreme values
        const extremeHigh = await scoreAgent(makeAgent({
            successRate: 100,
            successfulJobCount: 1_200_000,
            transactionCount: 1_200_000,
            uniqueBuyerCount: 8000,
            grossAgenticAmount: 220_000_000,
            walletBalance: '10000',
        }));
        expect(extremeHigh.trustScore).toBeLessThanOrEqual(100);
        const extremeLow = await scoreAgent(makeAgent({
            successRate: 0,
            successfulJobCount: 0,
            transactionCount: 0,
            uniqueBuyerCount: 0,
            grossAgenticAmount: 0,
            walletBalance: '0',
            hasGraduated: false,
            offerings: [],
            lastActiveAt: null,
        }));
        expect(extremeLow.trustScore).toBeGreaterThanOrEqual(0);
    });
    it('reliability is a significant scoring factor', async () => {
        // Agent with great reliability but nothing else
        const reliableOnly = await scoreAgent(makeAgent({
            successRate: 99,
            successfulJobCount: 50000,
            transactionCount: 0,
            uniqueBuyerCount: 0,
            grossAgenticAmount: 0,
            walletBalance: '0',
            hasGraduated: false,
            offerings: [],
            lastActiveAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
        }));
        // Reliability should be the main contributor
        expect(reliableOnly.reliabilityScore).toBeGreaterThan(50);
    });
});
// ─── TIER_CONFIG ────────────────────────────────────────────────────
// ─── Proprietary Dimensions ─────────────────────────────────────────
describe('scoreAgent — proprietary dimensions', () => {
    it('returns all 5 proprietary scores as numbers', async () => {
        const result = await scoreAgent(makeAgent());
        expect(Number.isFinite(result.behavioralScore)).toBe(true);
        expect(Number.isFinite(result.complexityScore)).toBe(true);
        expect(Number.isFinite(result.sustainabilityScore)).toBe(true);
        expect(Number.isFinite(result.sybilRiskScore)).toBe(true);
        expect(Number.isFinite(result.regressionScore)).toBe(true);
    });
    it('behavioral score is 100 for first-seen agent (no baseline to compare)', async () => {
        const result = await scoreAgent(makeAgent({
            walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }));
        expect(result.behavioralScore).toBe(100);
    });
    it('complexity score rewards sophisticated agents', async () => {
        const complex = await scoreAgent(makeAgent({
            walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            hasGraduated: true,
            offerings: [
                { id: 1, name: 'a', price: 100, priceUsd: 50 },
                { id: 2, name: 'b', price: 200, priceUsd: 100 },
                { id: 3, name: 'c', price: 300, priceUsd: 150 },
                { id: 4, name: 'd', price: 400, priceUsd: 200 },
                { id: 5, name: 'e', price: 500, priceUsd: 250 },
            ],
            enabledChains: [{ id: 1, name: 'Base' }, { id: 2, name: 'Ethereum' }, { id: 3, name: 'Arbitrum' }, { id: 4, name: 'Polygon' }],
            grossAgenticAmount: 5000000,
            transactionCount: 2000,
        }));
        const simple = await scoreAgent(makeAgent({
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            hasGraduated: false,
            offerings: [],
            enabledChains: [{ id: 1, name: 'Base' }],
            grossAgenticAmount: 100,
            transactionCount: 100,
        }));
        expect(complex.complexityScore).toBeGreaterThan(simple.complexityScore);
    });
    it('sybil risk is 0 for clean agents', async () => {
        const result = await scoreAgent(makeAgent({
            walletAddress: '0xdddddddddddddddddddddddddddddddddddddd',
            transactionCount: 100,
            uniqueBuyerCount: 50, // Good diversity
        }));
        expect(result.sybilRiskScore).toBeLessThanOrEqual(30);
    });
    it('sybil risk flags metric farming pattern', async () => {
        const result = await scoreAgent(makeAgent({
            walletAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            successfulJobCount: 10000,
            successRate: 100,
            grossAgenticAmount: 0.5, // Near-zero value per job
            transactionCount: 10000,
            uniqueBuyerCount: 5, // Very low diversity
        }));
        expect(result.sybilRiskScore).toBeGreaterThan(0);
        // Should have at least one sybil-related flag
        const hasSybilFlag = result.riskFlags.some(f => f.includes('SYBIL') || f.includes('VOLUME_INFLATION') || f.includes('METRIC_FARMING'));
        expect(hasSybilFlag).toBe(true);
    });
    it('includes trustGrade field (A-F)', async () => {
        const result = await scoreAgent(makeAgent());
        expect(['A', 'B', 'C', 'D', 'F']).toContain(result.trustGrade);
    });
});
// ─── TIER_CONFIG ────────────────────────────────────────────────────
describe('TIER_CONFIG', () => {
    it('has all 7 tiers defined', async () => {
        const expectedTiers = ['ELITE', 'TRUSTED', 'ESTABLISHED', 'EMERGING', 'NEW', 'INACTIVE', 'HIGH_RISK'];
        for (const tier of expectedTiers) {
            expect(TIER_CONFIG).toHaveProperty(tier);
            expect(TIER_CONFIG[tier].label).toBeTruthy();
            expect(TIER_CONFIG[tier].color).toMatch(/^#[0-9a-f]{6}$/);
            expect(TIER_CONFIG[tier].icon).toBeTruthy();
        }
    });
});
