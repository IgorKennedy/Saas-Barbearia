/**
 * Pricing calculator. All money in integer cents; percentages as 0–100.
 *
 * Definitions (per appointment/unit sold at price P):
 *   variable   = product cost consumed + service variable cost
 *   deductions = P × (commission% + tax% + card fee%)
 *   contribution margin (MC) = P − variable − deductions          ← NOT net profit
 *   fixed share = monthly fixed costs ÷ monthly capacity (appointments)
 *   break-even price  = (variable + fixed share) ÷ (1 − c − t − f)
 *   suggested price   = (variable + fixed share) ÷ (1 − c − t − f − m)   (m = target margin on price,
 *                       after fixed-cost allocation; it is an estimate, not accounting profit)
 *   appointments to hit revenue goal = ceil(goal ÷ P)
 *   appointments to cover fixed costs = ceil(fixed ÷ MC)  (only if MC > 0)
 */
export type PricingInput = {
  priceCents: number;
  variableCostCents: number;       // service variable cost + consumed products
  commissionPct: number;
  taxPct: number;
  cardFeePct: number;
  fixedCostsCents: number;         // per month
  monthlyCapacity: number;         // appointments per month
  revenueGoalCents: number;
  targetMarginPct: number;
};

export type PricingResult = {
  fixedSharePerUnitCents: number;
  deductionsCents: number;
  contributionMarginCents: number;
  contributionMarginPct: number;
  breakEvenPriceCents: number | null;
  suggestedPriceCents: number | null;
  unitsForRevenueGoal: number | null;
  unitsToCoverFixedCosts: number | null;
  warnings: string[];
};

const pctOk = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;

export function calculatePricing(i: PricingInput): PricingResult {
  const warnings: string[] = [];
  const nums = [i.priceCents, i.variableCostCents, i.fixedCostsCents, i.revenueGoalCents];
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) throw new RangeError("Valores monetários devem ser números não negativos.");
  if (![i.commissionPct, i.taxPct, i.cardFeePct, i.targetMarginPct].every(pctOk)) throw new RangeError("Percentuais devem estar entre 0 e 100.");
  if (!Number.isInteger(i.monthlyCapacity) || i.monthlyCapacity <= 0) throw new RangeError("A capacidade mensal deve ser um inteiro positivo.");

  const rate = (i.commissionPct + i.taxPct + i.cardFeePct) / 100;
  const fixedShare = Math.round(i.fixedCostsCents / i.monthlyCapacity);
  const deductions = Math.round(i.priceCents * rate);
  const mc = i.priceCents - i.variableCostCents - deductions;

  const base = i.variableCostCents + fixedShare;
  const denomBreakEven = 1 - rate;
  const denomSuggested = 1 - rate - i.targetMarginPct / 100;
  let breakEven: number | null = null, suggested: number | null = null;
  if (denomBreakEven > 0) breakEven = Math.ceil(base / denomBreakEven);
  else warnings.push("Comissão, impostos e taxas somam 100% ou mais: não há preço de equilíbrio.");
  if (denomSuggested > 0) suggested = Math.ceil(base / denomSuggested);
  else warnings.push("Deduções somadas à margem-alvo chegam a 100% ou mais: reduza a margem-alvo.");
  if (mc < 0) warnings.push("O preço atual não cobre custos variáveis e deduções (margem de contribuição negativa).");

  return {
    fixedSharePerUnitCents: fixedShare,
    deductionsCents: deductions,
    contributionMarginCents: mc,
    contributionMarginPct: i.priceCents > 0 ? Math.round((mc / i.priceCents) * 10000) / 100 : 0,
    breakEvenPriceCents: breakEven,
    suggestedPriceCents: suggested,
    unitsForRevenueGoal: i.priceCents > 0 ? Math.ceil(i.revenueGoalCents / i.priceCents) : null,
    unitsToCoverFixedCosts: mc > 0 ? Math.ceil(i.fixedCostsCents / mc) : null,
    warnings,
  };
}

/** Shelf product: price that keeps the target margin after fees and tax. */
export function suggestProductPrice(costCents: number, targetMarginPct: number, taxPct: number, cardFeePct: number): number {
  if (costCents < 0 || ![targetMarginPct, taxPct, cardFeePct].every(pctOk)) throw new RangeError("Entradas inválidas.");
  const d = 1 - (targetMarginPct + taxPct + cardFeePct) / 100;
  if (d <= 0) throw new RangeError("Margem, impostos e taxas somam 100% ou mais.");
  return Math.ceil(costCents / d);
}
