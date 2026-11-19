import type { AppConfig } from "../config.js";
import type { DeskDb } from "../db.js";
import type { Logger } from "../log.js";
import type { AlertView } from "../shared/types.js";

export class AlertCenter {
  readonly recent: AlertView[] = [];
  private readonly last = new Map<string, number>();

  constructor(
    private readonly db: DeskDb,
    private readonly log: Logger,
    private readonly config: AppConfig,
  ) {
    this.recent.push(...db.recentAlerts(40));
  }

  push(input: {
    kind: string;
    level: AlertView["level"];
    title: string;
    body: string;
    symbol?: string | null;
    dedupeKey: string;
    cooldownMs?: number;
  }): void {
    const now = Date.now();
    const previous = this.last.get(input.dedupeKey) ?? 0;
    if (now - previous < (input.cooldownMs ?? 5 * 60_000)) return;
    this.last.set(input.dedupeKey, now);
    const alert: AlertView = {
      id: crypto.randomUUID(),
      ts: now,
      kind: input.kind,
      level: input.level,
      title: input.title,
      body: input.body,
      symbol: input.symbol ?? null,
    };
    this.db.insertAlert(alert);
    this.recent.unshift(alert);
    if (this.recent.length > 80) this.recent.pop();
    this.log.info("alerta", `${input.title} — ${input.body}`);
    void this.deliver(alert);
  }

  private async deliver(alert: AlertView): Promise<void> {
    const text = `${alert.title}\n${alert.body}`;
    if (this.config.alertWebhook) {
      try {
        await fetch(this.config.alertWebhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "rogerio-crypto-trading-desk", alert }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch (error) {
        this.log.warn("alerta", `webhook falhou: ${error instanceof Error ? error.message : "erro"}`);
      }
    }
    if (this.config.telegramToken && this.config.telegramChat) {
      try {
        await fetch(`https://api.telegram.org/bot${this.config.telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.telegramChat, text: text.slice(0, 3500) }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch (error) {
        this.log.warn("alerta", `telegram falhou: ${error instanceof Error ? error.message : "erro"}`);
      }
    }
  }
}
