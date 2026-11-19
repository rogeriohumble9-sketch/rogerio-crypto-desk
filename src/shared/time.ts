export const TZ = "America/Sao_Paulo";
export const TZ_LABEL = "BRT";

export function formatBrt(ms: number, withSeconds = true): string {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  });
  return `${fmt.format(new Date(ms))} ${TZ_LABEL}`;
}

export function formatBrtClock(ms: number): string {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return `${fmt.format(new Date(ms))} ${TZ_LABEL}`;
}

/** Data civil YYYY-MM-DD em America/Sao_Paulo. */
export function sessionDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function sessionMonth(ms: number): string {
  return sessionDate(ms).slice(0, 7);
}

/** Semana ISO aproximada a partir da data civil de São Paulo (segunda como início). */
export function sessionWeekKey(ms: number): string {
  const [y, m, d] = sessionDate(ms).split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Converte um instante UTC para o "relógio de parede" de São Paulo
 * representado como timestamp UTC, para o eixo do gráfico.
 */
export function brtChartTime(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return Math.floor(
    Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(get("hour")),
      Number(get("minute")),
      Number(get("second")),
    ) / 1000,
  );
}

export function ageLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "sem leitura";
  const s = Math.round(ms / 1000);
  if (s < 60) return `há ${Math.max(1, s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return `há ${h} h`;
}
