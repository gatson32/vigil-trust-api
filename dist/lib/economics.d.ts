import type { ScoredAgent } from './scoring.js';
export interface EconomicProfile {
    estimatedRevenue: number;
    estimatedCosts: number;
    estimatedMargin: number;
    grossMarginPercent: number;
    revenueVerified: boolean;
    customerAcquisitionCost: number;
    customerLifetimeValue: number;
    clvToCacRatio: number;
    revenuePerDay: number;
    costPerTransaction: number;
    revenueConcentration: number;
    burnRate: number;
    marginScore: number;
    unitEconomicsScore: number;
    sustainabilityScore: number;
    compositeScore: number;
}
export declare function scoreEconomics(agent: ScoredAgent): EconomicProfile;
