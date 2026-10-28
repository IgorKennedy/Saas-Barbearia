import { describe, expect, it } from "vitest";
import { calculatePricing, suggestProductPrice } from "@/lib/domain/pricing";

const base = { priceCents: 5000, variableCostCents: 500, commissionPct: 40, taxPct: 6, cardFeePct: 4, fixedCostsCents: 600000, monthlyCapacity: 200, revenueGoalCents: 1500000, targetMarginPct: 20 };

describe("pricing calculator", () => {
  it("separates contribution margin from net profit", () => {
    const r = calculatePricing(base);
    expect(r.deductionsCents).toBe(2500);               // 50% of 5000
    expect(r.contributionMarginCents).toBe(2000);       // 5000 − 500 − 2500
    expect(r.fixedSharePerUnitCents).toBe(3000);        // 600000 / 200
    expect(r.contributionMarginCents - r.fixedSharePerUnitCents).toBe(-1000); // not yet profitable after fixed costs
  });
  it("computes break-even and suggested price from the documented formulas", () => {
    const r = calculatePricing(base);
    expect(r.breakEvenPriceCents).toBe(7000);           // (500+3000)/0.5
    expect(r.suggestedPriceCents).toBe(11667);          // 3500/0.3 = 11666.67 → ceil
  });
  it("computes volumes needed", () => {
    const r = calculatePricing(base);
    expect(r.unitsForRevenueGoal).toBe(300);            // 1,500,000 / 5,000
    expect(r.unitsToCoverFixedCosts).toBe(300);         // 600,000 / 2,000
  });
  it("warns instead of returning nonsense", () => {
    const r = calculatePricing({ ...base, commissionPct: 90, taxPct: 6, cardFeePct: 4 });
    expect(r.breakEvenPriceCents).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(calculatePricing({ ...base, priceCents: 900 }).warnings.join()).toMatch(/negativa/);
  });
  it("rejects invalid input", () => {
    expect(() => calculatePricing({ ...base, monthlyCapacity: 0 })).toThrow(RangeError);
    expect(() => calculatePricing({ ...base, taxPct: 101 })).toThrow(RangeError);
    expect(() => calculatePricing({ ...base, priceCents: -1 })).toThrow(RangeError);
  });
  it("prices shelf products for a target margin", () => {
    expect(suggestProductPrice(2000, 30, 6, 4)).toBe(3334);  // 2000/0.6 = 3333.33 → ceil
    expect(() => suggestProductPrice(2000, 90, 6, 4)).toThrow(RangeError);
  });
});
