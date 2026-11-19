import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DeskDb } from "../src/db.js";

const ADDR = "0xec85bc052ec5b6d6cb2b40f5caa45e39b61a77fe";

describe("padrões vindos do ambiente (Render reinicia com SQLite zerado)", () => {
  it("AUTOTRADE_PAUSED, COPY_PAUSED e COPY_SUSPENDED_TRADERS", () => {
    const off = loadConfig({});
    expect(off.autoTradePausedDefault).toBe(false);
    expect(off.copyPausedDefault).toBe(false);
    expect(off.copySuspendedDefault).toEqual([]);
    const on = loadConfig({ AUTOTRADE_PAUSED: "true", COPY_PAUSED: "true", COPY_SUSPENDED_TRADERS: ` ${ADDR.toUpperCase().replace("0X", "0x")} , lixo ` });
    expect(on.autoTradePausedDefault).toBe(true);
    expect(on.copyPausedDefault).toBe(true);
    expect(on.copySuspendedDefault).toEqual([ADDR]);
  });

  it("sem valor gravado vale o padrão do ambiente; valor gravado vence", () => {
    const db = new DeskDb(":memory:");
    db.migrate();
    expect(db.getAutoTrade()).toBe(true);
    db.autoTradeDefault = false;
    expect(db.getAutoTrade()).toBe(false); // AUTOTRADE_PAUSED=true
    db.saveAutoTrade(true);
    expect(db.getAutoTrade()).toBe(true);
    db.saveAutoTrade(false);
    db.autoTradeDefault = true;
    expect(db.getAutoTrade()).toBe(false); // gravado (pausa persistida) vence o padrão
  });
});
