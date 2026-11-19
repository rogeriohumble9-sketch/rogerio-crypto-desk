import { describe, expect, it } from "vitest";
import { accessCookie, cookieValue, hasAccessCookie, queryTokenMatches, requestIsHttps } from "../src/access.js";

describe("acesso do túnel", () => {
  it("aceita o token uma vez e reconhece o cookie depois", () => {
    expect(queryTokenMatches("segredo", "segredo")).toBe(true);
    expect(queryTokenMatches("outro", "segredo")).toBe(false);
    const cookie = accessCookie("segredo", true);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    const value = cookieValue(cookie, "desk_access");
    expect(hasAccessCookie(`desk_access=${value}`, "segredo")).toBe(true);
    expect(hasAccessCookie(`desk_access=${value}`, "outro")).toBe(false);
  });

  it("marca o cookie como seguro só quando o proxy diz https", () => {
    expect(accessCookie("segredo", false)).not.toContain("Secure");
    expect(requestIsHttps({ headers: { "x-forwarded-proto": "https" } } as never)).toBe(true);
    expect(requestIsHttps({ headers: { "x-forwarded-proto": "http" } } as never)).toBe(false);
  });
});
