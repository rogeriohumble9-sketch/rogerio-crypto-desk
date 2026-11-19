import { ageLabel, formatBrt, formatBrtClock } from "../../src/shared/time";

export { ageLabel, formatBrt, formatBrtClock };

export function usd(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "DADOS INDISPONÍVEIS";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function px(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "DADOS INDISPONÍVEIS";
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function pct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "DADOS INDISPONÍVEIS";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function compactUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "DADOS INDISPONÍVEIS";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `US$ ${(value / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} bi`;
  if (abs >= 1e6) return `US$ ${(value / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1e3) return `US$ ${(value / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`;
  return usd(value, 0);
}

export function signClass(value: number | null): string {
  if (value == null) return "flat";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}
