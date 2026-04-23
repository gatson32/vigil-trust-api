/**
 * Wallet-labeling pipeline — the "Nansen moat" for VIGIL.
 *
 * The formula is public; the moat is that we can answer:
 *   "Who is this wallet, really?"
 *   "What does this entity trade across markets?"
 *   "Is wallet A actually wallet B under a different handle?"
 *
 * This module provides the label taxonomy, heuristic labeling, and the
 * lookup API that Elite customers query. Launch-day shape is rule-based;
 * v2 adds graph-based clustering over funding paths.
 *
 * Labels attach to a wallet. A wallet can have multiple labels with
 * different confidence scores. Every label records provenance (why
 * we think this) so customers can verify.
 */

import type { PolymarketRiskReport } from './polymarket.js';

// ───────────────────────── TAXONOMY ─────────────────────────

export type LabelCategory =
  | 'entity'          // Known entity: "swisstony", a VC, a fund
  | 'archetype'       // Behavior class: geopolitics_specialist, penny_lottery, bonder
  | 'relationship'    // Graph edge: funded_by:0x..., likely_same_as:0x...
  | 'quality'         // Grade-derived: a_grade_forecaster, ins_insufficient_data
  | 'venue'           // Cross-venue: also_active_on_kalshi (future)
  | 'flag';           // Risk flag: sybil_suspect, wash_trader

export type LabelSource =
  | 'public_handle'        // Polymarket profile display name
  | 'behavior_heuristic'   // Derived from trading pattern
  | 'grade_threshold'      // Crossed an A/B/C/D/F boundary
  | 'on_chain_graph'       // Funding / tx graph analysis
  | 'manual_curation'      // VIGIL team review
  | 'community_report';    // User-submitted + verified

export interface WalletLabel {
  wallet: string;                  // lowercased 0x address
  category: LabelCategory;
  label: string;                   // the label value itself: "geopolitics_specialist", etc.
  confidence: number;              // 0..1
  source: LabelSource;
  provenance: string;              // human-readable "why we think this"
  assignedAt: string;              // ISO timestamp
  expiresAt: string | null;        // null = permanent, else auto-reevaluate
  metadata?: Record<string, unknown>;
}

// ───────────────────────── STORE ─────────────────────────

// In-memory store. v2 migrates to DB with GIN indexes on (wallet) and (label).
// Key: wallet (lowercased). Value: array of labels for that wallet.
const labelStore = new Map<string, WalletLabel[]>();

// Reverse index: label → Set<wallet>. Built on writes for fast "wallets with label X" lookup.
const reverseIndex = new Map<string, Set<string>>();

function reverseKey(category: LabelCategory, label: string): string {
  return `${category}:${label}`;
}

export function addLabel(label: WalletLabel): void {
  const wallet = label.wallet.toLowerCase();
  const normalized: WalletLabel = { ...label, wallet };
  const existing = labelStore.get(wallet) ?? [];
  // Replace existing label of same (category, label) rather than duplicating.
  const filtered = existing.filter(l => !(l.category === normalized.category && l.label === normalized.label));
  filtered.push(normalized);
  labelStore.set(wallet, filtered);

  const key = reverseKey(normalized.category, normalized.label);
  if (!reverseIndex.has(key)) reverseIndex.set(key, new Set());
  reverseIndex.get(key)!.add(wallet);
}

export function getLabels(wallet: string): WalletLabel[] {
  return labelStore.get(wallet.toLowerCase()) ?? [];
}

export function walletsWithLabel(category: LabelCategory, label: string): string[] {
  const set = reverseIndex.get(reverseKey(category, label));
  return set ? Array.from(set) : [];
}

export function labelStats(): { totalLabels: number; totalWallets: number; categoryCounts: Record<string, number> } {
  let total = 0;
  const counts: Record<string, number> = {};
  for (const labels of labelStore.values()) {
    for (const l of labels) {
      total++;
      counts[l.category] = (counts[l.category] ?? 0) + 1;
    }
  }
  return { totalLabels: total, totalWallets: labelStore.size, categoryCounts: counts };
}

// ───────────────────────── HEURISTIC LABELERS ─────────────────────────

/**
 * Derive labels from a freshly scored PolymarketRiskReport. Called by the
 * prescore cron after every wallet is graded. Idempotent: re-running with
 * the same report produces the same labels (replacing prior values).
 */
export function labelFromReport(report: PolymarketRiskReport): WalletLabel[] {
  const now = new Date().toISOString();
  const wallet = report.wallet.toLowerCase();
  const out: WalletLabel[] = [];

  // (1) Entity label from public handle if non-default
  const handle = report.displayName;
  if (handle && !handle.startsWith('0x') && handle.length > 2) {
    out.push({
      wallet, category: 'entity',
      label: handle.split('-')[0].toLowerCase(),
      confidence: 0.95,
      source: 'public_handle',
      provenance: `Polymarket displayName: "${handle}"`,
      assignedAt: now, expiresAt: null,
    });
  }

  // (2) Quality label — grade threshold
  const g = report.trustGrade;
  const ins = report.confidence?.ci95?.insufficientData ?? false;
  if (ins) {
    out.push({
      wallet, category: 'quality', label: 'insufficient_data',
      confidence: 1.0, source: 'grade_threshold',
      provenance: `CI95 span ≥ 20pts or n<30 resolved bets (n=${report.raw?.resolvedBets ?? 0})`,
      assignedAt: now, expiresAt: null,
    });
  } else if (g === 'A' || g === 'B') {
    out.push({
      wallet, category: 'quality', label: `${g.toLowerCase()}_grade_forecaster`,
      confidence: 0.9, source: 'grade_threshold',
      provenance: `Trust grade ${g}/${report.trustScore} with tight CI95`,
      assignedAt: now, expiresAt: null,
    });
  }

  // (3) Archetype — geopolitics specialist
  //     Heuristic: resolved bets dominate by category weight. Without a direct
  //     category breakdown here, we flag wallets whose market titles are
  //     geopolitics-heavy (see v2 for the full classifier).
  const catMix: Record<string, number> | undefined = (report as any).categoryMix;
  if (catMix && typeof catMix.geopolitics === 'number' && catMix.geopolitics > 0.4) {
    out.push({
      wallet, category: 'archetype', label: 'geopolitics_specialist',
      confidence: Math.min(1.0, catMix.geopolitics),
      source: 'behavior_heuristic',
      provenance: `${(catMix.geopolitics * 100).toFixed(0)}% of resolved bets in geopolitics markets`,
      assignedAt: now, expiresAt: null,
      metadata: { geopoliticsShare: catMix.geopolitics },
    });
  }

  // (4) Flag — penny-lottery pattern (many tiny bets)
  const flags = report.flags ?? [];
  if (flags.some(f => /penny|lottery/i.test(f))) {
    out.push({
      wallet, category: 'flag', label: 'penny_lottery',
      confidence: 0.85, source: 'behavior_heuristic',
      provenance: 'Many sub-$10 bets on long-odds outcomes (see scorecard flags)',
      assignedAt: now, expiresAt: null,
    });
  }

  // (5) Flag — receive-only / bonder pattern
  if (flags.some(f => /receive-only|bonder|transfer/i.test(f))) {
    out.push({
      wallet, category: 'flag', label: 'bonder_or_transfer_recipient',
      confidence: 0.75, source: 'behavior_heuristic',
      provenance: 'Wallet received positions via transfer rather than organic trading',
      assignedAt: now, expiresAt: null,
    });
  }

  // Persist
  for (const l of out) addLabel(l);
  return out;
}

/**
 * Mark a wallet as likely_same_as another wallet. Called by the graph clusterer
 * once we have funding-path analysis. Symmetric: labels both sides.
 */
export function linkSameEntity(walletA: string, walletB: string, confidence: number, provenance: string): void {
  const now = new Date().toISOString();
  addLabel({
    wallet: walletA, category: 'relationship',
    label: `likely_same_as:${walletB.toLowerCase()}`,
    confidence, source: 'on_chain_graph', provenance,
    assignedAt: now, expiresAt: null,
  });
  addLabel({
    wallet: walletB, category: 'relationship',
    label: `likely_same_as:${walletA.toLowerCase()}`,
    confidence, source: 'on_chain_graph', provenance,
    assignedAt: now, expiresAt: null,
  });
}

// ───────────────────────── PUBLIC API SHAPES ─────────────────────────

export interface LabelLookupResponse {
  wallet: string;
  labels: Array<Pick<WalletLabel, 'category' | 'label' | 'confidence' | 'source' | 'provenance' | 'assignedAt'>>;
  entityHandle: string | null;
  archetypes: string[];
  qualityTags: string[];
  flags: string[];
}

export function lookupLabels(wallet: string): LabelLookupResponse {
  const labels = getLabels(wallet);
  return {
    wallet: wallet.toLowerCase(),
    labels: labels.map(l => ({
      category: l.category, label: l.label, confidence: l.confidence,
      source: l.source, provenance: l.provenance, assignedAt: l.assignedAt,
    })),
    entityHandle: labels.find(l => l.category === 'entity')?.label ?? null,
    archetypes: labels.filter(l => l.category === 'archetype').map(l => l.label),
    qualityTags: labels.filter(l => l.category === 'quality').map(l => l.label),
    flags: labels.filter(l => l.category === 'flag').map(l => l.label),
  };
}
