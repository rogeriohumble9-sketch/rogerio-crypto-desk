import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { clampSettings } from "./domain/risk.js";
import { buildReport, periodBounds, reportToCsv, reportToMarkdown } from "./domain/reports.js";
import type { MarketHub } from "./market/hub.js";
import type { Memory } from "./services/agents.js";
import type { CopyDesk } from "./services/copyDesk.js";
import type { Simulator } from "./services/simulator.js";
import { buildBook, buildHealth, buildKlines, buildState, isInterval, type StateSources } from "./state.js";
import type { DeskLayout, Report } from "./shared/types.js";
import { accessCookie, hasAccessCookie, queryTokenMatches, requestIsHttps } from "./access.js";
import type { DeskDb } from "./db.js";

export interface HttpApp {
  port: number;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".map": "application/json",
};

export async function listenHttp(opts: {
  port: number;
  host: string;
  sources: StateSources;
  db: DeskDb;
  market: MarketHub;
  memory: Memory;
  sim: Simulator;
  copy: CopyDesk;
  publicDir: string;
  onAutoTrade: (enabled: boolean) => void;
  accessToken: string | null;
}): Promise<HttpApp> {
  const clients = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, buildHealth(opts.sources));
      if (!allow(req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, buildState(opts.sources));
      if (req.method === "GET" && url.pathname === "/api/stream") return stream(req, res);
      if (req.method === "GET" && url.pathname === "/api/klines") return klines(res, url);
      if (req.method === "GET" && url.pathname === "/api/book") return book(res, url);
      if (req.method === "GET" && url.pathname === "/api/reports") return json(res, 200, report(url));
      if (req.method === "GET" && url.pathname === "/api/reports/export") return exportReport(res, url);
      if (req.method === "PUT" && url.pathname === "/api/settings") return updateSettings(req, res);
      if (req.method === "PUT" && url.pathname === "/api/layout") return updateLayout(req, res);
      if (req.method === "PUT" && url.pathname === "/api/autotrade") return updateAuto(req, res);
      if (req.method === "POST" && url.pathname === "/api/watchlist") return addWatch(req, res);
      if (req.method === "DELETE" && url.pathname.startsWith("/api/watchlist/")) return removeWatch(res, decodeURIComponent(url.pathname.split("/").pop() ?? ""));
      if (req.method === "POST" && url.pathname === "/api/simulator/reset") {
        opts.sim.reset();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/copy/traders") return addCopy(req, res);
      if (req.method === "DELETE" && url.pathname.startsWith("/api/copy/traders/")) return removeCopy(res, decodeURIComponent(url.pathname.split("/").pop() ?? ""));
      if (req.method === "PUT" && url.pathname === "/api/copy/settings") return updateCopy(req, res);
      if (req.method === "POST" && url.pathname === "/api/copy/reset") {
        opts.copy.reset();
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET") return staticFile(res, url.pathname);
      json(res, 404, { error: "Rota não encontrada." });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : "Falha interna." });
    }
  });

  const timer = setInterval(() => {
    const payload = `event: state\ndata: ${JSON.stringify(buildState(opts.sources))}\n\n`;
    for (const client of clients) client.write(payload);
  }, 1000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  function allow(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const token = opts.accessToken;
    if (!token) return true;
    if (hasAccessCookie(req.headers.cookie, token)) return true;
    const provided = url.searchParams.get("token");
    if (queryTokenMatches(provided, token)) {
      url.searchParams.delete("token");
      const location = `${url.pathname}${url.search}`;
      res.writeHead(302, {
        Location: location,
        "Set-Cookie": accessCookie(token, requestIsHttps(req)),
        "Cache-Control": "no-store",
      });
      res.end();
      return false;
    }
    if (url.pathname.startsWith("/api/")) {
      json(res, 401, { error: "acesso negado" });
    } else {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><meta charset=\"utf-8\"><title>Mesa</title><p>Acesso negado. Abra o endereço uma vez com ?token= e o valor de DESK_ACCESS_TOKEN.</p>");
    }
    return false;
  }

  function stream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(buildState(opts.sources))}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  function klines(res: http.ServerResponse, url: URL): void {
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
    const interval = url.searchParams.get("interval") ?? "";
    if (!isInterval(interval)) return json(res, 400, { error: "Timeframe inválido." });
    const payload = buildKlines(opts.market, symbol, interval);
    if (!payload) return json(res, 404, { error: "Ativo fora da mesa." });
    json(res, 200, payload);
  }

  function book(res: http.ServerResponse, url: URL): void {
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
    const payload = buildBook(opts.market, symbol);
    if (!payload) return json(res, 404, { error: "Ativo fora da mesa." });
    json(res, 200, payload);
  }

  function report(url: URL): Report {
    const period = url.searchParams.get("period") === "weekly" || url.searchParams.get("period") === "monthly" ? url.searchParams.get("period")! : "daily";
    return makeReport(period as Report["period"]);
  }

  function exportReport(res: http.ServerResponse, url: URL): void {
    const period = url.searchParams.get("period") === "weekly" || url.searchParams.get("period") === "monthly" ? (url.searchParams.get("period") as Report["period"]) : "daily";
    const format = url.searchParams.get("format") === "csv" ? "csv" : "md";
    const data = makeReport(period);
    const body = format === "csv" ? reportToCsv(data) : reportToMarkdown(data);
    res.writeHead(200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="relatorio-${period}.${format === "csv" ? "csv" : "md"}"`,
    });
    res.end(body);
  }

  function makeReport(period: Report["period"]): Report {
    const now = Date.now();
    const bounds = periodBounds(period, now);
    return buildReport({
      period,
      now,
      signals: opts.db.signalsBetween(bounds.from, bounds.to).map((signal) => ({
        createdAt: signal.createdAt,
        direction: signal.direction,
        status: signal.status,
        symbol: signal.symbol,
        rejectReason: signal.rejectReason,
      })),
      trades: opts.sim.trades
        .filter((trade) => trade.status === "closed" && trade.closedAt != null)
        .map((trade) => ({ closedAt: trade.closedAt, status: trade.status, symbol: trade.symbol, realizedPnl: trade.realizedPnl })),
      news: opts.db.newsBetween(bounds.from, bounds.to).map((item) => ({ ts: item.ts, sentiment: item.sentiment })),
      regimes: opts.db.regimesSince(bounds.from),
    });
  }

  async function updateSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const current = opts.db.getSettings();
    const body = await readBody(req);
    const parsed = clampSettings({ ...current, ...body });
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    opts.db.saveSettings(parsed.value);
    if (opts.sim.trades.length === 0 && parsed.value.initialCapital !== current.initialCapital) opts.sim.reset();
    json(res, 200, parsed.value);
  }

  async function updateLayout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const layout: DeskLayout = body.layout === "clean" ? "clean" : "desk";
    opts.db.saveLayout(layout);
    json(res, 200, { layout });
  }

  async function updateAuto(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    opts.db.saveAutoTrade(enabled);
    opts.onAutoTrade(enabled);
    json(res, 200, { enabled });
  }

  async function addWatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const checked = await opts.market.validateSymbol(String(body.symbol ?? ""));
    if (!checked.ok) return json(res, 400, { error: checked.error });
    await opts.market.addSymbol(checked.symbol);
    json(res, 200, { symbol: checked.symbol });
  }

  async function addCopy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const result = opts.copy.addTrader(String(body.address ?? ""));
    if (!result.ok) return json(res, 400, { error: result.error });
    json(res, 200, { ok: true });
  }

  function removeCopy(res: http.ServerResponse, address: string): void {
    opts.copy.removeTrader(address);
    json(res, 200, { ok: true });
  }

  async function updateCopy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const patch: Parameters<CopyDesk["updateSettings"]>[0] = {};
    if (body.mode === "shared" || body.mode === "separate") patch.mode = body.mode;
    if (body.initialCapital != null) patch.initialCapital = Number(body.initialCapital);
    if (body.riskPct != null) patch.riskPct = Number(body.riskPct);
    if (body.dailyLossUsd != null) patch.dailyLossUsd = Number(body.dailyLossUsd);
    if (body.dailyTargetUsd != null) patch.dailyTargetUsd = Number(body.dailyTargetUsd);
    if (body.maxFillAgeMs != null) patch.maxFillAgeMs = Number(body.maxFillAgeMs);
    if (body.maxDeviationPct != null) patch.maxDeviationPct = Number(body.maxDeviationPct);
    const result = opts.copy.updateSettings(patch);
    if (!result.ok) return json(res, 400, { error: result.error });
    json(res, 200, result.value);
  }

  function removeWatch(res: http.ServerResponse, symbol: string): void {
    const result = opts.market.removeSymbol(symbol.toUpperCase());
    if (!result.ok) return json(res, 400, { error: result.error });
    json(res, 200, { ok: true });
  }

  function staticFile(res: http.ServerResponse, pathname: string): void {
    const root = path.resolve(opts.publicDir);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const target = path.resolve(root, `.${requested}`);
    if (!target.startsWith(root)) return json(res, 403, { error: "Caminho recusado." });
    const file = fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(root, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<p>Interface ainda não compilada. Rode npm run build.</p>");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  }

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(timer);
        for (const client of clients) client.end();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 100_000) throw new Error("Corpo grande demais.");
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
