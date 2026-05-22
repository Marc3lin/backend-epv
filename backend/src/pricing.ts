import type { Court } from "@prisma/client";

export type PriceConfig = {
  hourlyPriceCents: number;
  twoHourPromoCents?: number | null;
  promoActive?: boolean;
  promoDays?: string | null;
  promoStartMinutes?: number | null;
  promoEndMinutes?: number | null;
};

export function calculatePriceCents(court: Court, sport: string, durationHours: number, priceConfig?: PriceConfig | null) {
  if (durationHours < 1) throw new Error("A reserva minima e de 1 hora.");

  const fallback = getFallbackPriceConfig(court, sport);
  const hourlyPriceCents = priceConfig?.hourlyPriceCents ?? fallback.hourlyPriceCents;
  const twoHourPromoCents = priceConfig?.promoActive === false
    ? null
    : priceConfig?.twoHourPromoCents ?? fallback.twoHourPromoCents;

  if (durationHours === 1) return hourlyPriceCents;
  if (durationHours >= 2 && twoHourPromoCents) return Math.round(twoHourPromoCents + Math.max(0, durationHours - 2) * hourlyPriceCents);
  return Math.round(durationHours * hourlyPriceCents);
}

export function getFallbackPriceConfig(court: Court, sport: string): PriceConfig {
  const normalizedSport = sport.toLowerCase();
  const isFutsal = normalizedSport.includes("futsal");
  const isSand = court.type === "SAND_VOLLEY";

  if (isFutsal) return { hourlyPriceCents: 12000, twoHourPromoCents: null };
  if (isSand) return { hourlyPriceCents: 6000, twoHourPromoCents: 10000 };
  return { hourlyPriceCents: 10000, twoHourPromoCents: 18000 };
}

export function formatMoney(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}
