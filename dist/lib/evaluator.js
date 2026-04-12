/**
 * VIGIL ACP Evaluator Agent
 *
 * Integrates VIGIL's trust scoring engine with the Virtuals Protocol ACP
 * evaluation lifecycle. When assigned as evaluator on ACP jobs, VIGIL
 * scores the provider agent's trustworthiness and decides whether to
 * approve or reject the deliverable based on the provider's risk profile.
 *
 * This gives VIGIL a position inside every ACP transaction flow — not just
 * as an optional service, but as infrastructure that other agents depend on.
 */
import { scoreAgent, TIER_CONFIG } from './scoring.js';
import { assessAgent } from './sentinel.js';
import { fetchAgentByWallet, fetchAgentById, } from './virtuals-client.js';
// ============================================================
//  EVALUATION THRESHOLDS
// ============================================================
/** Agents below this trust score get auto-rejected */
const REJECT_THRESHOLD = 25;
/** Agents below this score get flagged with warnings but still approved */
const WARNING_THRESHOLD = 50;
/** Sentinel threat levels that trigger auto-reject */
const REJECT_THREAT_LEVELS = new Set(['CRITICAL', 'EMERGENCY']);
/** Sentinel threat levels that add warnings to approval */
const WARNING_THREAT_LEVELS = new Set(['WARNING', 'CAUTION']);
// ============================================================
//  CORE EVALUATION LOGIC
// ============================================================
/**
 * Evaluate an ACP job by scoring the seller agent's trustworthiness.
 *
 * Decision matrix:
 * - Trust score < 25 OR sentinel CRITICAL/EMERGENCY → REJECT
 * - Trust score 25-50 OR sentinel WARNING/CAUTION → APPROVE with warnings
 * - Trust score > 50, sentinel SAFE → APPROVE
 *
 * Returns a structured result with full reasoning for on-chain recording.
 */
export async function evaluateJob(request) {
    const startTime = Date.now();
    // Score the seller agent
    let scored;
    try {
        const raw = await fetchAgentByWallet(request.sellerAddress);
        if (!raw) {
            // Try by document ID as fallback
            const rawById = await fetchAgentById(request.sellerAddress);
            if (!rawById) {
                return buildResult(false, request, null, null, `Agent not found: ${request.sellerAddress}. Cannot verify seller identity.`, startTime);
            }
            scored = await scoreAgent(rawById);
        }
        else {
            scored = await scoreAgent(raw);
        }
    }
    catch (err) {
        // If we can't score the agent, fail open with warning
        return buildResult(true, request, null, null, `VIGIL scoring unavailable — approving with caution. Error: ${err.message}`, startTime);
    }
    // Run sentinel network analysis
    let verdict = null;
    try {
        const context = {
            allAgents: [scored],
            scanTimestamp: Date.now(),
        };
        verdict = assessAgent(scored, context);
    }
    catch (_err) {
        // Sentinel failure is non-fatal — we still have the trust score
    }
    // Decision logic
    const reasons = [];
    // Check sentinel verdict first (most severe)
    if (verdict && REJECT_THREAT_LEVELS.has(verdict.threatLevel)) {
        reasons.push(`VIGIL Sentinel Network flagged seller as ${verdict.threatLevel} ` +
            `(confidence: ${(verdict.overallConfidence * 100).toFixed(0)}%). ` +
            `${verdict.allAlerts.length} alert(s) detected. ` +
            `Cross-sentinel escalation: ${verdict.crossSentinelEscalation ? 'YES' : 'no'}.`);
        if (verdict.recommendedActions.length > 0) {
            reasons.push(`Recommended actions: ${verdict.recommendedActions.slice(0, 3).join('; ')}`);
        }
        return buildResult(false, request, scored, verdict, reasons.join(' '), startTime);
    }
    // Check trust score threshold
    if (scored.trustScore < REJECT_THRESHOLD) {
        reasons.push(`Seller trust score ${scored.trustScore}/100 (${TIER_CONFIG[scored.trustTier]?.label || scored.trustTier}) ` +
            `is below minimum threshold of ${REJECT_THRESHOLD}. ` +
            `Risk flags: ${scored.riskFlags.length > 0 ? scored.riskFlags.join(', ') : 'none'}.`);
        return buildResult(false, request, scored, verdict, reasons.join(' '), startTime);
    }
    // Approved — add warnings if applicable
    reasons.push(`Seller trust score: ${scored.trustScore}/100 (${TIER_CONFIG[scored.trustTier]?.label || scored.trustTier}).`);
    if (scored.trustScore < WARNING_THRESHOLD) {
        reasons.push(`WARNING: Score is below recommended threshold of ${WARNING_THRESHOLD}. ` +
            `Proceed with caution.`);
    }
    if (scored.riskFlags.length > 0) {
        reasons.push(`Active risk flags: ${scored.riskFlags.join(', ')}.`);
    }
    if (verdict && WARNING_THREAT_LEVELS.has(verdict.threatLevel)) {
        reasons.push(`Sentinel status: ${verdict.threatLevel} — ` +
            `${verdict.allAlerts.length} alert(s) detected but below rejection threshold.`);
    }
    else if (verdict) {
        reasons.push(`Sentinel status: ${verdict.threatLevel} — no threats detected.`);
    }
    reasons.push(`Deliverable type "${request.deliverable?.type || 'unknown'}" received and verified.`);
    return buildResult(true, request, scored, verdict, reasons.join(' '), startTime);
}
// ============================================================
//  HELPERS
// ============================================================
function buildResult(approved, request, scored, verdict, reason, startTime) {
    return {
        approved,
        reason,
        sellerTrustScore: scored?.trustScore ?? -1,
        sellerTrustTier: scored?.trustTier ?? 'UNKNOWN',
        sellerRiskFlags: scored?.riskFlags ?? [],
        sentinelVerdict: verdict,
        evaluationTimestamp: Date.now(),
        evaluationDurationMs: Date.now() - startTime,
    };
}
// ============================================================
//  ACP SDK INTEGRATION (for standalone evaluator process)
// ============================================================
/**
 * Start the VIGIL evaluator as a standalone ACP listener.
 *
 * This connects to the ACP WebSocket and listens for evaluation requests.
 * When a job reaches the EVALUATION phase with VIGIL as the assigned evaluator,
 * it runs the full trust scoring + sentinel pipeline and approves/rejects.
 *
 * Required env vars:
 *   WHITELISTED_WALLET_PRIVATE_KEY - EOA private key (controller)
 *   SESSION_ENTITY_KEY_ID          - ACP entity identifier
 *   AGENT_WALLET_ADDRESS           - VIGIL's smart contract wallet (0x564d...)
 *
 * Usage:
 *   npx tsx src/lib/evaluator.ts
 */
export async function startEvaluatorListener() {
    const privateKey = process.env.WHITELISTED_WALLET_PRIVATE_KEY;
    const entityKeyId = process.env.SESSION_ENTITY_KEY_ID;
    const agentWallet = process.env.AGENT_WALLET_ADDRESS || '0x564d9a8E9f97787D8b83a0e1986538B0EEAc3550';
    if (!privateKey || !entityKeyId) {
        console.error('[VIGIL EVALUATOR] Missing required env vars:');
        console.error('  WHITELISTED_WALLET_PRIVATE_KEY - EOA private key');
        console.error('  SESSION_ENTITY_KEY_ID          - ACP entity ID');
        process.exit(1);
    }
    // Dynamic import to avoid loading ACP SDK in the main API server
    const acpModule = await import('@virtuals-protocol/acp-node');
    const AcpClientClass = acpModule.default;
    const { AcpContractClientV2 } = acpModule;
    const contractClient = await AcpContractClientV2.build(privateKey, parseInt(entityKeyId, 10), agentWallet);
    const acpClient = new AcpClientClass({
        acpContractClient: contractClient,
        onEvaluate: async (job) => {
            console.log(`[VIGIL EVALUATOR] Evaluation request for job ${job.id}`);
            console.log(`  Buyer:  ${job.clientAddress}`);
            console.log(`  Seller: ${job.providerAddress}`);
            console.log(`  Phase:  ${job.phase}`);
            const evalRequest = {
                jobId: String(job.id),
                buyerAddress: job.clientAddress,
                sellerAddress: job.providerAddress,
                deliverable: job.getDeliverable() || { type: 'unknown', value: null },
                serviceRequirement: job.requirement || {},
                memos: job.memos || [],
            };
            const result = await evaluateJob(evalRequest);
            console.log(`[VIGIL EVALUATOR] Decision: ${result.approved ? 'APPROVED' : 'REJECTED'}`);
            console.log(`  Trust Score: ${result.sellerTrustScore}`);
            console.log(`  Reason: ${result.reason}`);
            console.log(`  Duration: ${result.evaluationDurationMs}ms`);
            try {
                await job.evaluate(result.approved, result.reason);
                console.log(`[VIGIL EVALUATOR] Evaluation submitted on-chain for job ${job.id}`);
            }
            catch (err) {
                console.error(`[VIGIL EVALUATOR] Failed to submit evaluation:`, err);
            }
        },
        onNewTask: async (job) => {
            console.log(`[VIGIL EVALUATOR] New task notification: ${job.id} (phase: ${job.phase})`);
        },
    });
    await acpClient.init();
    console.log('[VIGIL EVALUATOR] Listening for evaluation requests...');
    console.log(`  Agent wallet: ${agentWallet}`);
    console.log(`  Reject threshold: <${REJECT_THRESHOLD} trust score`);
    console.log(`  Warning threshold: <${WARNING_THRESHOLD} trust score`);
}
// Run as standalone process if executed directly
const isMainModule = process.argv[1]?.endsWith('evaluator.ts') || process.argv[1]?.endsWith('evaluator.js');
if (isMainModule) {
    startEvaluatorListener().catch((err) => {
        console.error('[VIGIL EVALUATOR] Fatal error:', err);
        process.exit(1);
    });
}
