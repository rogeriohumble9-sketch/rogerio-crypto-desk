export const CORE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "BNBUSDT", "SOLUSDT"] as const;
export type CoreSymbol = (typeof CORE_SYMBOLS)[number];

export const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export type Regime = "alta" | "baixa" | "lateral" | "indisponivel";
export type Direction = "BUY" | "SELL" | "WAIT" | "DATA_UNAVAILABLE";
export type Style = "SCALPING" | "SWING";
export type Confidence = "Forte" | "Moderada" | "Fraca";
export type AgentId = "market" | "technical" | "news" | "signal" | "risk";
export type AgentHealth = "starting" | "healthy" | "unhealthy";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RiskSettings {
  initialCapital: number;
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  dailyProfitTargetPct: number;
  feePctPerSide: number;
  slippagePct: number;
  maxOpenPositions: number;
  maxLossStreak: number;
  extremeVolAtrPct: number;
  maxTotalRiskPct: number;
}

export interface Criterion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface TickerView {
  symbol: string;
  price: number | null;
  changePct: number | null;
  sessionChangePct: number | null;
  quoteVolume: number | null;
  high: number | null;
  low: number | null;
  updatedAt: number | null;
  ageMs: number | null;
  stale: boolean;
  source: string | null;
  spark: number[];
}

export interface BookLevel {
  price: number;
  qty: number;
}

export interface BookView {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  updatedAt: number | null;
  ageMs: number | null;
  stale: boolean;
}

export interface TechCell {
  interval: Interval;
  close: number | null;
  rsi: number | null;
  macdHist: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  sma200: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  atr: number | null;
  atrPct: number | null;
  realizedVolPct: number | null;
  structure: "alta" | "baixa" | "lateral" | "indisponivel";
  volumeRatio: number | null;
  breakout: string | null;
  reversal: string | null;
  support: number | null;
  resistance: number | null;
  stale: boolean;
  note: string;
}

export type DeskLayout = "desk" | "clean";
export type ActivityTag = "EXEC" | "FILL" | "SCAN" | "RISK" | "NEWS" | "WHALE";

export interface ActivityLine {
  id: string;
  ts: number;
  tag: ActivityTag;
  text: string;
  symbol: string | null;
}

export interface AgentView {
  id: AgentId;
  name: string;
  role: string;
  status: AgentHealth;
  lastHeartbeat: number | null;
  ageMs: number | null;
  message: string;
  restarts: number;
  /** Rateio do P&L simulado das operações em que o agente participou. Null se a simulação não está pronta. */
  contributionUsd: number | null;
}

export interface SignalView {
  id: string;
  symbol: string;
  style: Style;
  direction: Direction;
  status: "approved" | "rejected" | "expired" | "proposed";
  price: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  timeframe: string;
  rr: number | null;
  confidence: Confidence | null;
  score: number;
  criteria: Criterion[];
  justification: string;
  createdAt: number;
  validUntil: number | null;
  rejectReason: string | null;
}

export interface ReadingView {
  symbol: string;
  style: Style;
  direction: Direction;
  confidence: Confidence | null;
  score: number;
  maxScore: number;
  timeframe: string;
  justification: string;
  criteria: Criterion[];
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  rr: number | null;
  price: number | null;
  updatedAt: number;
  tradable: boolean;
}

export interface TradeView {
  id: string;
  signalId: string | null;
  symbol: string;
  style: Style;
  side: "BUY" | "SELL";
  status: "open" | "closed";
  qty: number;
  qtyOpen: number;
  entryFill: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  tp1Hit: boolean;
  tp1At: number | null;
  fees: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

export interface AccountView {
  initialCapital: number;
  cash: number;
  equity: number | null;
  realizedPnl: number;
  unrealizedPnl: number | null;
  dayPnl: number | null;
  dayPnlPct: number | null;
  weekPnl: number | null;
  monthPnl: number | null;
  peakEquity: number | null;
  drawdownPct: number | null;
  winRate: number | null;
  startedAt: number | null;
  riskPerTradeUsd: number;
  dailyLossLimitUsd: number;
  dailyTargetUsd: number;
  liveRiskUsd: number | null;
  closedTrades: number;
  wins: number;
  losses: number;
  lossStreak: number;
  sessionLossStreak: number;
  openPositions: number;
  openRiskPct: number;
  blocked: null | "loss" | "profit" | "streak";
  blockReason: string | null;
  sessionDate: string;
  equityCurve: { t: number; equity: number }[];
}

export interface NewsView {
  id: string;
  ts: number;
  source: string;
  title: string;
  link: string | null;
  summary: string;
  sentiment: "positivo" | "negativo" | "neutro";
  relevance: "alta" | "media" | "baixa";
  confirmation: "confirmado" | "rumor" | "indeterminado";
  heuristic: true;
}

export interface FileNote {
  name: string;
  path: string;
  updatedAt: number;
  content: string;
  missing: boolean;
}

export interface CopySettings {
  mode: "separate" | "shared";
  initialCapital: number;
  riskPct: number;
  dailyLossUsd: number;
  dailyTargetUsd: number;
  maxFillAgeMs: number;
  maxDeviationPct: number;
}

export interface CopyTraderView {
  address: string;
  displayName: string | null;
  accountValue: number | null;
  dayPnl: number | null;
  dayRoi: number | null;
  dayVolume: number | null;
  weekPnl: number | null;
  copiedPnl: number | null;
  positions: {
    coin: string;
    side: "long" | "short";
    size: number;
    entry: number | null;
    mark: number | null;
    leverage: number | null;
    unrealized: number | null;
  }[];
  fills: CopyTapeFill[];
  feedAgeMs: number | null;
  feedStale: boolean;
  updatedAt: number | null;
  error: string | null;
}

export interface CopyTapeFill {
  id: string;
  coin: string;
  time: number;
  px: number;
  sz: number;
  side: "BUY" | "SELL";
  dir: string;
  source: "ws" | "rest";
  outcome: "copiada" | "descartada" | "historico";
  reason: string;
  ourSide: "BUY" | "SELL" | null;
  ourQty: number | null;
  ourEntry: number | null;
  ourStop: number | null;
  ourPnl: number | null;
}

export interface CopyPositionView {
  id: string;
  address: string;
  coin: string;
  side: "BUY" | "SELL";
  qty: number;
  entry: number;
  stop: number;
  stopSource: "publico" | "atr";
  sourceLeverage: number | null;
  unrealizedPnl: number | null;
  openedAt: number;
}

export type CopyLogTag = "SYNC" | "MIRROR" | "FILL" | "SKIP" | "TRACK" | "EXIT";

export interface CopyEventView {
  id: string;
  ts: number;
  address: string | null;
  coin: string | null;
  action: CopyLogTag;
  reason: string;
}

export interface CopyCurvePoint {
  t: number;
  equity: number;
  fillId: string;
}

export interface CopyWatchWindow {
  label: string;
  pnl: number | null;
  roi: number | null;
  winRatio: number | null;
  sourceTime: number | null;
}

export interface CopyBlockedView {
  kind: "hyperliquid" | "okx";
  id: string;
  name: string;
  reason: string;
}

export interface CopyWatchView {
  name: string;
  code: string;
  profileUrl: string;
  fetchedAt: number | null;
  error: string | null;
  drawdown: null;
  aum: number | null;
  copyTraderPnl: number | null;
  windows: CopyWatchWindow[];
}

export interface CopyView {
  settings: CopySettings;
  cash: number;
  equity: number | null;
  totalPnl: number | null;
  drawdownPct: number | null;
  winRate: number | null;
  streak: number;
  copyCount: number;
  dayPnl: number | null;
  volume: number;
  curve: CopyCurvePoint[];
  blocked: null | "loss" | "profit";
  blockReason: string | null;
  startedAt: number | null;
  traders: CopyTraderView[];
  watches: CopyWatchView[];
  blockedSeeds: CopyBlockedView[];
  suggestions: string[];
  positions: CopyPositionView[];
  events: CopyEventView[];
  ws: "conectando" | "ao vivo" | "reconectando" | "off";
}

export interface OrderView {
  id: string;
  ts: number;
  symbol: string;
  kind: "ENTRY" | "EXIT";
  side: "BUY" | "SELL";
  reason: "OPEN" | "TP1" | "TP2" | "SL";
  price: number;
  qty: number;
  status: "filled";
}

export interface AlertView {
  id: string;
  ts: number;
  kind: string;
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  symbol: string | null;
}

export interface LogView {
  ts: number;
  level: string;
  scope: string;
  message: string;
}

export interface FeedSymbolHealth {
  tickerAgeMs: number | null;
  tickerStale: boolean;
  bookAgeMs: number | null;
  bookStale: boolean;
  klineAgeMs: Partial<Record<Interval, number | null>>;
  klineStale: Partial<Record<Interval, boolean>>;
}

export interface HealthReport {
  ok: boolean;
  ready: boolean;
  time: number;
  timezone: "America/Sao_Paulo";
  uptimeSec: number;
  restBase: string;
  wsBase: string;
  usingFallback: boolean;
  wsStatus: string;
  lastWsMessageAgeMs: number | null;
  feeds: Record<string, FeedSymbolHealth>;
  agents: AgentView[];
  staleFeeds: string[];
}

export interface DashboardState {
  now: number;
  timezone: "America/Sao_Paulo";
  safety: string;
  market: {
    regime: Regime;
    btcDominance: number | null;
    totalMarketCapUsd: number | null;
    dominanceUpdatedAt: number | null;
    dominanceSource: string;
    totalQuoteVolume: number | null;
    avgAtrPct: number | null;
    extremeVol: boolean;
    comment: string;
    updatedAt: number | null;
  };
  feeds: {
    wsStatus: string;
    restBase: string;
    wsBase: string;
    usingFallback: boolean;
    staleSymbols: string[];
    lastWsMessageAgeMs: number | null;
  };
  tickers: TickerView[];
  agents: AgentView[];
  opportunities: SignalView[];
  readings: ReadingView[];
  signals: SignalView[];
  trades: TradeView[];
  account: AccountView;
  settings: RiskSettings;
  news: NewsView[];
  whales: FileNote | null;
  riskNotes: FileNote | null;
  alerts: AlertView[];
  watchlist: string[];
  core: string[];
  technical: Record<string, Partial<Record<Interval, TechCell>>>;
  logs: LogView[];
  activity: ActivityLine[];
  orders: OrderView[];
  autoTrade: boolean;
  layout: DeskLayout;
  copy: CopyView;
  financasDir: string | null;
  liveKlines: Record<string, { openTime: number; open: number; high: number; low: number; close: number; volume: number } | null>;
}

export interface KlineResponse {
  symbol: string;
  interval: Interval;
  stale: boolean;
  ageMs: number | null;
  bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  ema9: { time: number; value: number }[];
  ema21: { time: number; value: number }[];
  ema50: { time: number; value: number }[];
}

export interface ReportAsset {
  symbol: string;
  pnl: number;
  trades: number;
}

export interface Report {
  period: "daily" | "weekly" | "monthly";
  label: string;
  from: number;
  to: number;
  generatedAt: number;
  signals: number;
  buySignals: number;
  sellSignals: number;
  approved: number;
  rejected: number;
  positiveTrades: number;
  negativeTrades: number;
  winRate: number | null;
  pnl: number;
  bestAsset: ReportAsset | null;
  worstAsset: ReportAsset | null;
  agents: { id: AgentId; name: string; summary: string }[];
  rejectReasons: { reason: string; count: number }[];
}
