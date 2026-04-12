export interface AgentRaw {
    id: number;
    documentId: string;
    name: string;
    description: string;
    walletAddress: string;
    profilePic: string | null;
    category: string;
    tokenAddress: string | null;
    symbol: string | null;
    twitterHandle: string | null;
    createdAt: string;
    updatedAt: string;
    lastActiveAt: string | null;
    successfulJobCount: number;
    successRate: number;
    uniqueBuyerCount: number;
    transactionCount: number;
    grossAgenticAmount: number;
    hasGraduated: boolean;
    walletBalance: string;
    isHighRisk: boolean | null;
    jobs: Array<{
        id: number;
        name: string;
        type: string;
        price: number;
    }>;
    resources: Array<unknown>;
    offerings: Array<{
        id: number;
        name: string;
        price: number;
        priceUsd: number;
    }>;
    enabledChains: Array<{
        id: number;
        name: string;
    }>;
    metrics: {
        successfulJobCount: number;
        successRate: number;
        uniqueBuyerCount: number;
        isOnline: boolean;
        minsFromLastOnlineTime: number;
        transactionCount: number;
        grossAgenticAmount: number;
        revenue: number | null;
        rating: number | null;
        lastActiveAt: string | null;
    };
    revenue: number | null;
    rating: number | null;
    role: string | null;
    cluster: string | null;
}
export interface ScoredAgent {
    name: string;
    documentId: string;
    walletAddress: string;
    profilePic: string | null;
    description: string;
    category: string;
    symbol: string | null;
    twitterHandle: string | null;
    cluster: string | null;
    role: string | null;
    hasGraduated: boolean;
    isOnline: boolean;
    successRate: number;
    successfulJobCount: number;
    uniqueBuyerCount: number;
    transactionCount: number;
    grossAgenticAmount: number;
    walletBalance: number;
    jobCount: number;
    resourceCount: number;
    offeringCount: number;
    chainCount: number;
    accountAgeDays: number;
    daysSinceActive: number;
    revenue: number;
    reliabilityScore: number;
    activityScore: number;
    economicScore: number;
    reputationScore: number;
    longevityScore: number;
    behavioralScore: number;
    complexityScore: number;
    sustainabilityScore: number;
    sybilRiskScore: number;
    regressionScore: number;
    trustScore: number;
    trustTier: 'ELITE' | 'TRUSTED' | 'ESTABLISHED' | 'EMERGING' | 'NEW' | 'INACTIVE' | 'HIGH_RISK';
    trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';
    riskFlags: string[];
}
export declare function scoreAgent(agent: AgentRaw): Promise<ScoredAgent>;
export declare const TIER_CONFIG: {
    readonly ELITE: {
        readonly label: "Elite";
        readonly color: "#00ff88";
        readonly bg: "rgba(0,255,136,0.1)";
        readonly icon: "◆";
    };
    readonly TRUSTED: {
        readonly label: "Trusted";
        readonly color: "#00ccff";
        readonly bg: "rgba(0,204,255,0.1)";
        readonly icon: "◇";
    };
    readonly ESTABLISHED: {
        readonly label: "Established";
        readonly color: "#ffaa00";
        readonly bg: "rgba(255,170,0,0.1)";
        readonly icon: "○";
    };
    readonly EMERGING: {
        readonly label: "Emerging";
        readonly color: "#ff6600";
        readonly bg: "rgba(255,102,0,0.1)";
        readonly icon: "△";
    };
    readonly NEW: {
        readonly label: "New";
        readonly color: "#888888";
        readonly bg: "rgba(136,136,136,0.1)";
        readonly icon: "·";
    };
    readonly INACTIVE: {
        readonly label: "Inactive";
        readonly color: "#444444";
        readonly bg: "rgba(68,68,68,0.1)";
        readonly icon: "✕";
    };
    readonly HIGH_RISK: {
        readonly label: "High Risk";
        readonly color: "#ff0044";
        readonly bg: "rgba(255,0,68,0.1)";
        readonly icon: "⚠";
    };
};
