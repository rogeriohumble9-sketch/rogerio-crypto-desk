export interface SeedWatch {
  name: string;
  code: string;
}

export interface SeedBlocked {
  kind: "hyperliquid" | "okx";
  id: string;
  name: string;
  reason: string;
}

export interface CopySeed {
  copy: string[];
  blocked: SeedBlocked[];
  watch: SeedWatch[];
}

export const PILOT_COPY_ADDRESS = "0xec85bc052ec5b6d6cb2b40f5caa45e39b61a77fe";

/** Veredito do gestor de risco. Substitui a lista curta anterior. */
export const RISK_VERDICT: CopySeed = {
  copy: [PILOT_COPY_ADDRESS],
  blocked: [
    {
      kind: "hyperliquid",
      id: "0x10e14ba2d77263543be1bdb2851b0933ddf4f4bd",
      name: "0x10e1…4bd",
      reason: "3x com 100% da margem usada",
    },
    {
      kind: "okx",
      id: "0206AE3AC5461FEB",
      name: "Charely",
      reason: "−30,6% em 365 dias",
    },
  ],
  watch: [
    { name: "Idle-Vaporware-Taro", code: "69975B4CBC86203B" },
    { name: "BTV-Michael", code: "8253D21C046EE47C" },
    { name: "mimidaidan", code: "5E5ADB958B5FE902" },
  ],
};

const BLOCK_HINT = /inadequado para copiar|100%\s*usada|não entra nesta lista|nao entra nesta lista|charely/i;

/** Lê 2_copy_traders.md e aplica o veredito: só o piloto é copiado; bloqueados nunca entram. */
export function parseCopySeed(markdown: string): CopySeed {
  const foundCopy = new Set<string>();
  const watch: SeedWatch[] = [];
  const seenCodes = new Set<string>();
  const sections = markdown.split(/\n(?=###\s+)/);
  for (const section of sections) {
    const addresses = [...section.matchAll(/0x[a-fA-F0-9]{40}/g)].map((match) => match[0].toLowerCase());
    const risky = BLOCK_HINT.test(section);
    for (const address of addresses) {
      if (!risky && /hyperliquid/i.test(section)) foundCopy.add(address);
    }
    const heading = section.match(/^###\s+\d+\)\s+(.+?)\s+—/m)?.[1]?.trim();
    const codes = [
      ...section.matchAll(/uniqueCode[`\s=:]+([A-F0-9]{16})/gi),
      ...section.matchAll(/\*\*Identificador:\*\*\s+`([A-F0-9]{16})`/gi),
    ];
    for (const match of codes) {
      const code = match[1].toUpperCase();
      if (seenCodes.has(code) || risky) continue;
      seenCodes.add(code);
      watch.push({ name: heading || code, code });
    }
  }
  return applyRiskVerdict({ copy: [...foundCopy], blocked: [], watch });
}

export function applyRiskVerdict(parsed: CopySeed): CopySeed {
  const blockedIds = new Set(RISK_VERDICT.blocked.map((item) => item.id.toLowerCase()));
  const watch = (parsed.watch.length ? parsed.watch : RISK_VERDICT.watch).filter((item) => !blockedIds.has(item.code.toLowerCase()));
  return {
    copy: RISK_VERDICT.copy.filter((address) => !blockedIds.has(address)),
    blocked: RISK_VERDICT.blocked,
    watch,
  };
}
