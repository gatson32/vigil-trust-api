// VIGIL Proprietary — Economic Sustainability & Unit Economics Engine
// Revenue without profit = debt. Scores agents on actual financial health.
// Patent-pending scoring methodology. All rights reserved.

import type { ScoredAgent } from './scoring.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface EconomicProfile {
  // Raw metrics
  estimatedRevenue: number;
  estimatedCosts: number;          // Gas + protocol fees
  estimatedMargin: number;         // Revenue - Costs
  grossMarginPercent: number;      // (Revenue - Costs) / Revenue

  // Customer economics
  customerAcquisitionCost: number; // Estimated CAC
  customerLifetimeValue: number;   // Estimated CLV
  clvToCacRatio: number;           // CLV / CAC — key SaaS metric

  // Sustainability signals
  revenuePerDay: number;
  costPerTransaction: number;
  revenueConcentration: number;    // HHI of revenue sources (0-1, lower = better)
  burnRate: number;                // If losing money, how fast?

  // Scores (0-100)
  marginScore: number;
  unitEconomicsScore: number;
  sustainabilityScore: number;
  compositeScore: number;
}

// ─── Constants ──────────────────────────────────────────────────────

// Average gas costs on Base L2 (in USD equivalent)
const AVG_GAS_COST_BASE = 0.005;       // ~$0.005 per tx on Base
const PROTOCOL_FEE_RATE = 0.025;       // 2.5% ACP protocol fee estimate
const VIRTUALS_GRADUATION_COST = 100;  // Estimated graduation cost in USD

// ─── Scoring ────────────────────────────────────────────────────────

export function scoreEconomics(agent: ScoredAgent): EconomicProfile {
  // === Revenue Estimation ===
  const estimatedRevenue = agent.revenue > 0 ? agent.revenue :
    agent.grossAgenticAmount * 0.05; // Assume 5% of aGDP is agent revenue if not reported

  // === Cost Estimation ===
  const gasCosts = agent.transactionCount * AVG_GAS_COST_BASE;
  const protocolFees = agent.grossAgenticAmount * PROTOCOL_FEE_RATE;
  const graduationCost = agent.hasGraduated ? VIRTUALS_GRADUATION_COST : 0;
  const estimatedCosts = gasCosts + protocolFees + graduationCost;

  // === Margin ===
  const estimatedMargin = estimatedRevenue - estimatedCosts;
  const grossMarginPercent = estimatedRevenue > 0
    ? (estimatedMargin / estimatedRevenue) * 100
    : 0;

  // === Customer Economics ===
  // CAC: estimated cost to acquire each unique buyer
  const customerAcquisitionCost = agent.uniqueBuyerCount > 0
    ? estimatedCosts / agent.uniqueBuyerCount
    : 0;

  // CLV: estimated lifetime value per customer
  const repeatRate = agent.uniqueBuyerCount > 0
    ? agent.transactionCount / agent.uniqueBuyerCount
    : 0;
  const revenuePerTx = agent.transactionCount > 0
    ? estimatedRevenue / agent.transactionCount
    : 0;
  const customerLifetimeValue = revenuePerTx * repeatRate;

  const clvToCacRatio = customerAcquisitionCost > 0
    ? customerLifetimeValue / customerAcquisitionCost
    : 0;

  // === Sustainability Signals ===
  const revenuePerDay = agent.accountAgeDays > 0
    ? estimatedRevenue / agent.accountAgeDays
    : 0;

  const costPerTransaction = agent.transactionCount > 0
    ? estimatedCosts / agent.transactionCount
    : 0;

  // Revenue concentration — how dependent on top buyers
  // Approximate HHI from buyer count (real data would use actual distribution)
  const revenueConcentration = agent.uniqueBuyerCount > 0
    ? Math.max(0, 1 - Math.log(agent.uniqueBuyerCount) / Math.log(1000))
    : 1.0;

  const burnRate = estimatedMargin < 0
    ? Math.abs(estimatedMargin) / Math.max(1, agent.accountAgeDays)
    : 0;

  // === Margin Score (0-100) ===
  let marginScore: number;
  if (grossMarginPercent >= 50) marginScore = 95;
  else if (grossMarginPercent >= 30) marginScore = 80;
  else if (grossMarginPercent >= 10) marginScore = 60;
  else if (grossMarginPercent >= 0) marginScore = 40;
  else if (grossMarginPercent >= -20) marginScore = 20;
  else marginScore = 5;  // Deep negative margins

  // === Unit Economics Score (0-100) ===
  let unitEconomicsScore: number;
  if (clvToCacRatio >= 5) unitEconomicsScore = 95;
  else if (clvToCacRatio >= 3) unitEconomicsScore = 80;
  else if (clvToCacRatio >= 1.5) unitEconomicsScore = 60;
  else if (clvToCacRatio >= 1) unitEconomicsScore = 40;
  else if (clvToCacRatio > 0) unitEconomicsScore = 20;
  else unitEconomicsScore = 5;  // No customers or negative unit economics

  // === Sustainability Score (0-100) ===
  // Combines margin stability, customer diversification, and growth signals
  const diversificationBonus = Math.min(30, (1 - revenueConcentration) * 30);
  const growthSignal = revenuePerDay > 0 && burnRate === 0 ? 20 : 0;
  const marginContribution = Math.min(50, marginScore * 0.5);
  const sustainabilityScore = Math.min(100, Math.round(
    marginContribution + diversificationBonus + growthSignal
  ));

  // === Composite ===
  const compositeScore = Math.round(
    marginScore * 0.35 +
    unitEconomicsScore * 0.35 +
    sustainabilityScore * 0.30
  );

  return {
    estimatedRevenue: round2(estimatedRevenue),
    estimatedCosts: round2(estimatedCosts),
    estimatedMargin: round2(estimatedMargin),
    grossMarginPercent: round2(grossMarginPercent),
    customerAcquisitionCost: round2(customerAcquisitionCost),
    customerLifetimeValue: round2(customerLifetimeValue),
    clvToCacRatio: round2(clvToCacRatio),
    revenuePerDay: round2(revenuePerDay),
    costPerTransaction: round2(costPerTransaction),
    revenueConcentration: round2(revenueConcentration),
    burnRate: round2(burnRate),
    marginScore,
    unitEconomicsScore,
    sustainabilityScore,
    compositeScore,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
