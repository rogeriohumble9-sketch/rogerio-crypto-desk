import type { AgentId, Report, ReportAsset } from "../shared/types.js";
import { sessionDate, sessionMonth, sessionWeekKey } from "../shared/time.js";

export interface ReportSignal {
  createdAt: number;
  direction: string;
  status: string;
  symbol: string;
  rejectReason: string | null;
}

export interface ReportTrade {
  closedAt: number | null;
  status: string;
  symbol: string;
  realizedPnl: number;
}

export interface ReportNews {
  ts: number;
  sentiment: string;
}

export interface ReportRegime {
  ts: number;
  regime: string;
}

const BRT = "-03:00";

export function startOfCivilDay(date: string): number {
  return Date.parse(`${date}T00:00:00${BRT}`);
}

export function periodBounds(period: Report["period"], now: number): { from: number; to: number; label: string } {
  const to = now;
  if (period === "daily") {
    const day = sessionDate(now);
    return { from: startOfCivilDay(day), to, label: `Diário ${day} BRT` };
  }
  if (period === "weekly") {
    const monday = sessionWeekKey(now);
    return { from: startOfCivilDay(monday), to, label: `Semanal a partir de ${monday} BRT` };
  }
  const month = sessionMonth(now);
  return { from: startOfCivilDay(`${month}-01`), to, label: `Mensal ${month} BRT` };
}

export function buildReport(input: {
  period: Report["period"];
  now: number;
  signals: ReportSignal[];
  trades: ReportTrade[];
  news: ReportNews[];
  regimes: ReportRegime[];
}): Report {
  const bounds = periodBounds(input.period, input.now);
  const signals = input.signals.filter((s) => s.createdAt >= bounds.from && s.createdAt <= bounds.to);
  const trades = input.trades.filter(
    (t) => t.status === "closed" && t.closedAt != null && t.closedAt >= bounds.from && t.closedAt <= bounds.to,
  );
  const news = input.news.filter((n) => n.ts >= bounds.from && n.ts <= bounds.to);
  const regimes = input.regimes.filter((r) => r.ts >= bounds.from && r.ts <= bounds.to);
  const buySignals = signals.filter((s) => s.direction === "BUY").length;
  const sellSignals = signals.filter((s) => s.direction === "SELL").length;
  const approved = signals.filter((s) => s.status === "approved").length;
  const rejected = signals.filter((s) => s.status === "rejected").length;
  const positiveTrades = trades.filter((t) => t.realizedPnl > 0).length;
  const negativeTrades = trades.filter((t) => t.realizedPnl <= 0).length;
  const pnl = trades.reduce((a, t) => a + t.realizedPnl, 0);
  const byAsset = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const row = byAsset.get(t.symbol) ?? { pnl: 0, trades: 0 };
    row.pnl += t.realizedPnl;
    row.trades += 1;
    byAsset.set(t.symbol, row);
  }
  const assets: ReportAsset[] = [...byAsset.entries()].map(([symbol, row]) => ({ symbol, ...row }));
  assets.sort((a, b) => b.pnl - a.pnl);
  const reasons = new Map<string, number>();
  for (const s of signals) {
    if (s.status !== "rejected" || !s.rejectReason) continue;
    reasons.set(s.rejectReason, (reasons.get(s.rejectReason) ?? 0) + 1);
  }
  const changes = regimes.reduce((n, r, i) => n + (i > 0 && r.regime !== regimes[i - 1].regime ? 1 : 0), 0);
  const posNews = news.filter((n) => n.sentiment === "positivo").length;
  const negNews = news.filter((n) => n.sentiment === "negativo").length;
  const agents: { id: AgentId; name: string; summary: string }[] = [
    {
      id: "market",
      name: "Analista de Mercado",
      summary: `${regimes.length} leitura(s) de regime, ${changes} mudança(s). Último: ${regimes.at(-1)?.regime ?? "sem leitura"}.`,
    },
    {
      id: "technical",
      name: "Analista Técnico",
      summary: `${signals.length} leitura(s) de sinal no período a partir dos indicadores (RSI, MACD, médias, Bollinger, ATR).`,
    },
    {
      id: "news",
      name: "Analista de Notícias",
      summary: `${news.length} item(ns): ${posNews} positivo(s), ${negNews} negativo(s). Classificação heurística.`,
    },
    {
      id: "signal",
      name: "Analista de Sinais",
      summary: `${approved} aprovado(s), ${rejected} rejeitado(s), ${buySignals} compra(s) e ${sellSignals} venda(s) registrados.`,
    },
    {
      id: "risk",
      name: "Gestor de Risco",
      summary:
        rejected === 0
          ? "Nenhuma rejeição registrada neste período."
          : `${rejected} rejeição(ões). Motivo mais comum: ${[...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"}.`,
    },
  ];
  return {
    period: input.period,
    label: bounds.label,
    from: bounds.from,
    to: bounds.to,
    generatedAt: input.now,
    signals: signals.length,
    buySignals,
    sellSignals,
    approved,
    rejected,
    positiveTrades,
    negativeTrades,
    winRate: trades.length ? positiveTrades / trades.length : null,
    pnl,
    bestAsset: assets[0] ?? null,
    worstAsset: assets.length ? assets[assets.length - 1] : null,
    agents,
    rejectReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  };
}

export function reportToMarkdown(report: Report): string {
  const pct = report.winRate == null ? "—" : `${(report.winRate * 100).toFixed(1)}%`;
  const money = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "USD" });
  const lines = [
    `# Relatório ${report.label}`,
    ``,
    `Gerado em dados simulados. Nenhuma ordem real foi enviada.`,
    ``,
    `- Sinais registrados: ${report.signals}`,
    `- Compras: ${report.buySignals} · Vendas: ${report.sellSignals}`,
    `- Aprovados: ${report.approved} · Rejeitados: ${report.rejected}`,
    `- Trades positivos: ${report.positiveTrades} · Negativos: ${report.negativeTrades}`,
    `- Taxa de acerto (trades fechados): ${pct}`,
    `- P&L simulado realizado: ${money(report.pnl)}`,
    `- Melhor ativo: ${report.bestAsset ? `${report.bestAsset.symbol} (${money(report.bestAsset.pnl)})` : "—"}`,
    `- Pior ativo: ${report.worstAsset ? `${report.worstAsset.symbol} (${money(report.worstAsset.pnl)})` : "—"}`,
    ``,
    `## Agentes`,
    ...report.agents.map((a) => `- **${a.name}:** ${a.summary}`),
    ``,
    `## Motivos de rejeição`,
    ...(report.rejectReasons.length
      ? report.rejectReasons.map((r) => `- ${r.reason}: ${r.count}`)
      : ["- Nenhum"]),
    ``,
  ];
  return lines.join("\n");
}

export function reportToCsv(report: Report): string {
  const rows = [
    ["periodo", "sinais", "compras", "vendas", "aprovados", "rejeitados", "trades_positivos", "trades_negativos", "win_rate", "pnl", "melhor_ativo", "pior_ativo"],
    [
      report.label,
      report.signals,
      report.buySignals,
      report.sellSignals,
      report.approved,
      report.rejected,
      report.positiveTrades,
      report.negativeTrades,
      report.winRate ?? "",
      report.pnl.toFixed(2),
      report.bestAsset?.symbol ?? "",
      report.worstAsset?.symbol ?? "",
    ],
  ];
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(";"))
    .join("\n");
}
