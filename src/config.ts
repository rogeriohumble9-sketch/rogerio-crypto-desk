export interface AppConfig {
  port: number;
  host: string;
  sqlitePath: string;
  financasDir: string | null;
  restPrimary: string;
  restFallback: string;
  wsPrimary: string;
  wsFallback: string;
  staleTickerMs: number;
  staleBookMs: number;
  staleKlineMs: number;
  minQuoteVolume: number;
  coingeckoUrl: string;
  alertWebhook: string | null;
  telegramToken: string | null;
  telegramChat: string | null;
  accessToken: string | null;
  accessTokenSha256: string | null;
  /** Padrão da pausa da cópia quando não há valor gravado no SQLite (COPY_PAUSED=true). */
  copyPausedDefault: boolean;
  /** Padrão da pausa da carteira principal (AUTOTRADE_PAUSED=true) quando não há valor gravado. */
  autoTradePausedDefault: boolean;
  /** Traders suspensos por padrão (COPY_SUSPENDED_TRADERS=0x…,0x…) quando não há lista gravada. */
  copySuspendedDefault: string[];
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: num(env.PORT, 8080),
    host: env.HOST?.trim() || "0.0.0.0",
    sqlitePath: env.SQLITE_PATH?.trim() || "./data/desk.sqlite",
    financasDir: clean(env.FINANCAS_DIR),
    restPrimary: (env.BINANCE_REST_BASE?.trim() || "https://api.binance.com").replace(/\/$/, ""),
    restFallback: (env.BINANCE_REST_FALLBACK?.trim() || "https://data-api.binance.vision").replace(/\/$/, ""),
    wsPrimary: (env.BINANCE_WS_BASE?.trim() || "wss://stream.binance.com:9443").replace(/\/$/, ""),
    wsFallback: (env.BINANCE_WS_FALLBACK?.trim() || "wss://data-stream.binance.vision").replace(/\/$/, ""),
    staleTickerMs: num(env.STALE_TICKER_MS, 20_000),
    staleBookMs: num(env.STALE_BOOK_MS, 30_000),
    staleKlineMs: num(env.STALE_KLINE_MS, 10 * 60_000),
    minQuoteVolume: num(env.MIN_QUOTE_VOLUME_USDT, 2_000_000),
    coingeckoUrl: env.COINGECKO_GLOBAL_URL?.trim() || "https://api.coingecko.com/api/v3/global",
    alertWebhook: clean(env.ALERT_WEBHOOK_URL),
    telegramToken: clean(env.TELEGRAM_BOT_TOKEN),
    telegramChat: clean(env.TELEGRAM_CHAT_ID),
    accessToken: clean(env.DESK_ACCESS_TOKEN),
    accessTokenSha256: clean(env.DESK_ACCESS_TOKEN_SHA256),
    autoTradePausedDefault: /^(1|true|yes|on|sim)$/i.test(env.AUTOTRADE_PAUSED?.trim() ?? ""),
    copySuspendedDefault: (env.COPY_SUSPENDED_TRADERS ?? "").split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => /^0x[a-f0-9]{40}$/.test(item)),
    copyPausedDefault: /^(1|true|yes|on|sim)$/i.test(env.COPY_PAUSED?.trim() ?? ""),
  };
}
