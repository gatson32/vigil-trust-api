#!/usr/bin/env tsx
// VIGIL — Full Ecosystem Sybil & Trust Scan
// Scans ALL agents on Virtuals Protocol, scores them, detects sybil risk,
// and generates an aggregate trust report.
// Usage: npx tsx src/scripts/scan-all-agents.ts
import { scoreAgent } from '../lib/scoring.js';
import { fetchAgentsPage } from '../lib/virtuals-client.js';
import { analyzeSybilRisk, saveScanResult } from '../lib/sybil.js';
import { recordSnapshot } from '../lib/history.js';
import { initDb, closeDb, isDbConnected } from '../lib/db.js';
// ─── Config ────────────────────────────────────────────────────────
const MAX_PAGES = 50; // Max pages to scan (100 agents per page = 5000 agents max)
const PAGE_SIZE = 100;
const DELAY_MS = 1500; // Delay between API calls to avoid rate limiting
const REPORT_FILE = 'vigil-trust-report.json';
// ─── Main ──────────────────────────────────────────────────────────
async function main() {
    console.log(`
╔══════════════════════════════════════════════════╗
║     VIGIL Full Ecosystem Scan v1.0               ║
║     Sybil Detection + Trust Scoring              ║
╚══════════════════════════════════════════════════╝
  `);
    const startTime = Date.now();
    // Initialize DB if available
    const dbConnected = await initDb();
    console.log(`[SCAN] Storage mode: ${dbConnected ? 'PostgreSQL' : 'Memory'}`);
    const allResults = [];
    let page = 1;
    let totalAgents = 0;
    let hasMore = true;
    while (hasMore && page <= MAX_PAGES) {
        try {
            console.log(`[SCAN] Fetching page ${page}...`);
            const result = await fetchAgentsPage(page, PAGE_SIZE, 'grossAgenticAmount:desc');
            if (!result.data || result.data.length === 0) {
                console.log(`[SCAN] No more agents on page ${page}. Done.`);
                hasMore = false;
                break;
            }
            totalAgents = result.meta.pagination.total;
            console.log(`[SCAN] Page ${page}: ${result.data.length} agents (${allResults.length + result.data.length}/${totalAgents})`);
            // Score all agents on this page
            const scored = await Promise.all(result.data.map(scoreAgent));
            for (const agent of scored) {
                // Run sybil analysis
                const sybilResult = analyzeSybilRisk(agent);
                // Persist scan result if DB available
                if (isDbConnected()) {
                    await saveScanResult(agent, sybilResult);
                }
                // Record history snapshot
                await recordSnapshot(agent.walletAddress, agent.name, {
                    trustScore: agent.trustScore,
                    trustTier: agent.trustTier,
                    reliabilityScore: agent.reliabilityScore,
                    activityScore: agent.activityScore,
                    economicScore: agent.economicScore,
                    reputationScore: agent.reputationScore,
                    longevityScore: agent.longevityScore,
                    behavioralScore: agent.behavioralScore,
                    complexityScore: agent.complexityScore,
                    sustainabilityScore: agent.sustainabilityScore,
                    sybilRiskScore: agent.sybilRiskScore,
                    regressionScore: agent.regressionScore,
                    riskFlags: agent.riskFlags,
                });
                allResults.push({
                    agent: {
                        name: agent.name,
                        walletAddress: agent.walletAddress,
                        category: agent.category,
                        symbol: agent.symbol || null,
                        trustScore: agent.trustScore,
                        trustTier: agent.trustTier,
                        trustGrade: agent.trustGrade,
                        riskFlags: agent.riskFlags,
                    },
                    sybil: {
                        sybilRiskScore: sybilResult.sybilRiskScore,
                        collusionDetected: sybilResult.collusionDetected,
                        quarantineRecommended: sybilResult.quarantineRecommended,
                        flagCount: sybilResult.flags.length,
                        flagTypes: sybilResult.flags.map(f => f.type),
                    },
                    metrics: {
                        successRate: agent.successRate,
                        successfulJobCount: agent.successfulJobCount,
                        uniqueBuyerCount: agent.uniqueBuyerCount,
                        transactionCount: agent.transactionCount,
                        grossAgenticAmount: agent.grossAgenticAmount,
                        accountAgeDays: agent.accountAgeDays,
                    },
                });
            }
            // Check if more pages
            const totalPages = result.meta.pagination.pageCount;
            if (page >= totalPages) {
                hasMore = false;
            }
            else {
                page++;
                // Rate limit delay
                await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            }
        }
        catch (err) {
            console.error(`[SCAN] Error on page ${page}:`, err.message);
            // Retry once after longer delay
            await new Promise(resolve => setTimeout(resolve, 5000));
            try {
                page++;
                continue;
            }
            catch {
                console.error(`[SCAN] Skipping page ${page} after retry failure`);
                page++;
            }
        }
    }
    const duration = Date.now() - startTime;
    console.log(`\n[SCAN] Completed: ${allResults.length} agents scanned in ${(duration / 1000).toFixed(1)}s`);
    // Generate aggregate report
    const report = generateReport(allResults, duration, dbConnected);
    // Write report to file
    const { writeFileSync } = await import('fs');
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`[REPORT] Written to ${REPORT_FILE}`);
    // Print summary
    printSummary(report);
    // Clean up
    await closeDb();
}
// ─── Report Generation ─────────────────────────────────────────────
function generateReport(results, durationMs, dbConnected) {
    const trustDistribution = {
        ELITE: 0, TRUSTED: 0, ESTABLISHED: 0, EMERGING: 0, NEW: 0, INACTIVE: 0, FLAGGED: 0,
    };
    const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    const flagTypeCounts = {};
    let totalTrust = 0;
    let totalSuccess = 0;
    let totalJobs = 0;
    let totalAgdp = 0;
    let activeCount = 0;
    let dormantCount = 0;
    let sybilFlagged = 0;
    let collusionCount = 0;
    let quarantineCount = 0;
    let totalSybilRisk = 0;
    const riskDist = { clean: 0, low: 0, medium: 0, high: 0 };
    const scores = [];
    for (const r of results) {
        // Trust distribution
        const tier = r.agent.trustTier;
        if (tier in trustDistribution)
            trustDistribution[tier]++;
        // Grade distribution
        const grade = r.agent.trustGrade;
        if (grade in gradeDistribution)
            gradeDistribution[grade]++;
        // Aggregate metrics
        totalTrust += r.agent.trustScore;
        totalSuccess += r.metrics.successRate;
        totalJobs += r.metrics.successfulJobCount;
        totalAgdp += r.metrics.grossAgenticAmount;
        scores.push(r.agent.trustScore);
        // Activity
        if (r.metrics.accountAgeDays <= 7 || r.metrics.transactionCount > 0)
            activeCount++;
        if (r.metrics.accountAgeDays > 30 && r.metrics.transactionCount === 0)
            dormantCount++;
        // Sybil
        totalSybilRisk += r.sybil.sybilRiskScore;
        if (r.sybil.sybilRiskScore >= 25)
            sybilFlagged++;
        if (r.sybil.collusionDetected)
            collusionCount++;
        if (r.sybil.quarantineRecommended)
            quarantineCount++;
        if (r.sybil.sybilRiskScore < 25)
            riskDist.clean++;
        else if (r.sybil.sybilRiskScore < 50)
            riskDist.low++;
        else if (r.sybil.sybilRiskScore < 75)
            riskDist.medium++;
        else
            riskDist.high++;
        for (const ft of r.sybil.flagTypes) {
            flagTypeCounts[ft] = (flagTypeCounts[ft] || 0) + 1;
        }
    }
    const n = results.length || 1;
    scores.sort((a, b) => a - b);
    const medianTrust = scores.length > 0
        ? scores[Math.floor(scores.length / 2)]
        : 0;
    const topFlagTypes = Object.entries(flagTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count }));
    const topAgents = [...results]
        .sort((a, b) => b.agent.trustScore - a.agent.trustScore)
        .slice(0, 20);
    const highRiskAgents = results
        .filter(r => r.sybil.sybilRiskScore >= 50)
        .sort((a, b) => b.sybil.sybilRiskScore - a.sybil.sybilRiskScore);
    return {
        meta: {
            title: 'VIGIL Virtuals Protocol Trust Report — Q2 2026',
            generatedAt: new Date().toISOString(),
            totalAgentsScanned: results.length,
            scanDuration: `${(durationMs / 1000).toFixed(1)}s`,
            storageMode: dbConnected ? 'postgresql' : 'memory',
            version: '1.0.0',
        },
        trustDistribution,
        gradeDistribution,
        sybilAnalysis: {
            totalFlagged: sybilFlagged,
            collusionDetected: collusionCount,
            quarantineRecommended: quarantineCount,
            avgSybilRiskScore: Math.round(totalSybilRisk / n),
            riskDistribution: riskDist,
            topFlagTypes,
        },
        ecosystemHealth: {
            avgTrustScore: Math.round(totalTrust / n),
            medianTrustScore: medianTrust,
            avgSuccessRate: Math.round((totalSuccess / n) * 10) / 10,
            totalJobs,
            totalAgdp: Math.round(totalAgdp * 100) / 100,
            activeAgents: activeCount,
            dormantAgents: dormantCount,
        },
        topAgents,
        highRiskAgents,
        agents: results,
    };
}
// ─── Summary Print ─────────────────────────────────────────────────
function printSummary(report) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║            VIGIL ECOSYSTEM TRUST REPORT — Q2 2026           ║
╠══════════════════════════════════════════════════════════════╣
║  Agents Scanned:     ${String(report.meta.totalAgentsScanned).padEnd(38)}║
║  Scan Duration:      ${report.meta.scanDuration.padEnd(38)}║
║  Storage Mode:       ${report.meta.storageMode.padEnd(38)}║
╠══════════════════════════════════════════════════════════════╣
║                    TRUST DISTRIBUTION                        ║
║  ELITE (80-100):     ${String(report.trustDistribution.ELITE).padEnd(38)}║
║  TRUSTED (60-79):    ${String(report.trustDistribution.TRUSTED).padEnd(38)}║
║  ESTABLISHED (40-59):${String(report.trustDistribution.ESTABLISHED).padEnd(39)}║
║  EMERGING (20-39):   ${String(report.trustDistribution.EMERGING).padEnd(38)}║
║  NEW (0-19):         ${String(report.trustDistribution.NEW).padEnd(38)}║
║  INACTIVE:           ${String(report.trustDistribution.INACTIVE).padEnd(38)}║
║  FLAGGED:            ${String(report.trustDistribution.FLAGGED).padEnd(38)}║
╠══════════════════════════════════════════════════════════════╣
║                    ECOSYSTEM HEALTH                          ║
║  Avg Trust Score:    ${String(report.ecosystemHealth.avgTrustScore).padEnd(38)}║
║  Median Trust Score: ${String(report.ecosystemHealth.medianTrustScore).padEnd(38)}║
║  Avg Success Rate:   ${String(report.ecosystemHealth.avgSuccessRate + '%').padEnd(38)}║
║  Total Jobs:         ${String(report.ecosystemHealth.totalJobs.toLocaleString()).padEnd(38)}║
║  Total aGDP:         $${String(report.ecosystemHealth.totalAgdp.toLocaleString()).padEnd(37)}║
╠══════════════════════════════════════════════════════════════╣
║                    SYBIL ANALYSIS                            ║
║  Agents Flagged:     ${String(report.sybilAnalysis.totalFlagged).padEnd(38)}║
║  Collusion Detected: ${String(report.sybilAnalysis.collusionDetected).padEnd(38)}║
║  Quarantine Rec'd:   ${String(report.sybilAnalysis.quarantineRecommended).padEnd(38)}║
║  Avg Sybil Risk:     ${String(report.sybilAnalysis.avgSybilRiskScore).padEnd(38)}║
║  Risk Distribution:                                          ║
║    Clean (0-24):     ${String(report.sybilAnalysis.riskDistribution.clean).padEnd(38)}║
║    Low (25-49):      ${String(report.sybilAnalysis.riskDistribution.low).padEnd(38)}║
║    Medium (50-74):   ${String(report.sybilAnalysis.riskDistribution.medium).padEnd(38)}║
║    High (75-100):    ${String(report.sybilAnalysis.riskDistribution.high).padEnd(38)}║
╠══════════════════════════════════════════════════════════════╣
║                    TOP FLAG TYPES                            ║`);
    for (const { type, count } of report.sybilAnalysis.topFlagTypes.slice(0, 5)) {
        console.log(`║  ${type.padEnd(22)} ${String(count).padEnd(36)}║`);
    }
    console.log(`╠══════════════════════════════════════════════════════════════╣
║                    TOP 10 TRUSTED AGENTS                     ║`);
    for (const r of report.topAgents.slice(0, 10)) {
        const name = r.agent.name.slice(0, 20).padEnd(20);
        const score = String(r.agent.trustScore).padEnd(5);
        const tier = r.agent.trustTier.padEnd(12);
        console.log(`║  ${name} Score: ${score} Tier: ${tier}║`);
    }
    if (report.highRiskAgents.length > 0) {
        console.log(`╠══════════════════════════════════════════════════════════════╣
║                    HIGH RISK AGENTS (Sybil ≥ 50)             ║`);
        for (const r of report.highRiskAgents.slice(0, 10)) {
            const name = r.agent.name.slice(0, 18).padEnd(18);
            const risk = String(r.sybil.sybilRiskScore).padEnd(4);
            const flags = r.sybil.flagTypes.slice(0, 2).join(', ').slice(0, 25).padEnd(25);
            console.log(`║  ${name} Risk: ${risk} ${flags}║`);
        }
    }
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
}
// ─── Run ───────────────────────────────────────────────────────────
main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
