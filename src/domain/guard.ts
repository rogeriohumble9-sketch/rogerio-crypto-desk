export interface GuardInput {
  /** Limite de perda diária em US$ (positivo). */
  dailyLossUsd: number;
  /** P&L do dia = realizado + aberto, já com as taxas de entrada e saída (patrimônio atual − patrimônio no início da sessão). */
  dayPnl: number;
  /** Perda adicional possível se todos os stops abertos forem atingidos a partir do preço atual (inclui taxa de saída). */
  openRiskUsd: number;
  openCount: number;
}

export interface GuardDecision {
  close: boolean;
  reason: string | null;
  lossTakenUsd: number;
  remainingUsd: number;
  usedPct: number;
}

/** Fração do limite diário a partir da qual a mesa fecha tudo ao iniciar ou se recuperar de uma queda de feed. */
export const GUARD_USED_FRACTION = 0.8;

/**
 * Guarda de partida/recuperação: com posições abertas e o dia perto do limite, fecha tudo a mercado sem esperar ordem.
 * Dispara se o limite restante é menor ou igual ao risco das posições abertas, ou se 80% ou mais do limite já foi usado.
 */
export function startupGuard(input: GuardInput): GuardDecision {
  const lossTakenUsd = Math.max(0, -input.dayPnl);
  const remainingUsd = Math.max(0, input.dailyLossUsd - lossTakenUsd);
  const usedPct = input.dailyLossUsd > 0 ? (lossTakenUsd / input.dailyLossUsd) * 100 : 100;
  if (input.openCount <= 0) return { close: false, reason: null, lossTakenUsd, remainingUsd, usedPct };
  if (usedPct >= GUARD_USED_FRACTION * 100) {
    return {
      close: true,
      reason: `guarda de partida/recuperação: ${usedPct.toFixed(0)}% do limite diário de US$ ${input.dailyLossUsd.toFixed(2)} já usado (perda US$ ${lossTakenUsd.toFixed(2)}, realizado + aberto, com taxas)`,
      lossTakenUsd,
      remainingUsd,
      usedPct,
    };
  }
  if (remainingUsd <= input.openRiskUsd) {
    return {
      close: true,
      reason: `guarda de partida/recuperação: limite restante US$ ${remainingUsd.toFixed(2)} não cobre o risco aberto US$ ${input.openRiskUsd.toFixed(2)}`,
      lossTakenUsd,
      remainingUsd,
      usedPct,
    };
  }
  return { close: false, reason: null, lossTakenUsd, remainingUsd, usedPct };
}

/** Controla quando a guarda roda: uma vez na partida e uma vez a cada volta de uma queda de preços. */
export class RecoveryGate {
  private armed = true;

  /** Informe se todos os preços necessários estão disponíveis agora. Retorna true quando a guarda deve rodar. */
  observe(pricesAvailable: boolean): boolean {
    if (!pricesAvailable) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}
