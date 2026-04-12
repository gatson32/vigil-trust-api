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
import { type SentinelVerdict } from './sentinel.js';
export interface EvaluationRequest {
    jobId: string;
    buyerAddress: string;
    sellerAddress: string;
    deliverable: {
        type: string;
        value: unknown;
    };
    serviceRequirement: unknown;
    memos: unknown[];
}
export interface EvaluationResult {
    approved: boolean;
    reason: string;
    sellerTrustScore: number;
    sellerTrustTier: string;
    sellerRiskFlags: string[];
    sentinelVerdict: SentinelVerdict | null;
    evaluationTimestamp: number;
    evaluationDurationMs: number;
}
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
export declare function evaluateJob(request: EvaluationRequest): Promise<EvaluationResult>;
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
export declare function startEvaluatorListener(): Promise<void>;
