export type PricingTier = { participants: number; credit: number };

export type PricingJson = {
  currency: string;
  base_price: number;
  tiers: PricingTier[];
};

export function parsePricingJson(input: unknown): PricingJson | null {
  if (!input || typeof input !== "object") return null;
  const any = input as any;
  if (typeof any.currency !== "string") return null;
  if (typeof any.base_price !== "number") return null;
  if (!Array.isArray(any.tiers)) return null;
  const tiers: PricingTier[] = any.tiers
    .filter((t: any) => t && typeof t.participants === "number" && typeof t.credit === "number")
    .map((t: any) => ({ participants: t.participants, credit: t.credit }))
    .sort((a: PricingTier, b: PricingTier) => a.participants - b.participants);
  return { currency: any.currency, base_price: any.base_price, tiers };
}

export function computeReachedTiers(pricing: PricingJson, participantCount: number): PricingTier[] {
  return pricing.tiers.filter((t) => participantCount >= t.participants);
}






