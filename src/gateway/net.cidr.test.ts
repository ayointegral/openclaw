import { describe, expect, it } from "vitest";
import { isIpInCidr, isTrustedProxyAddress } from "./net.js";

describe("isIpInCidr", () => {
  it("matches exact IP with no CIDR suffix", () => {
    expect(isIpInCidr("192.168.1.1", "192.168.1.1")).toBe(true);
  });

  it("does not match different exact IP", () => {
    expect(isIpInCidr("192.168.1.2", "192.168.1.1")).toBe(false);
  });

  it("matches IP within /24 range", () => {
    expect(isIpInCidr("192.168.107.2", "192.168.107.0/24")).toBe(true);
    expect(isIpInCidr("192.168.107.254", "192.168.107.0/24")).toBe(true);
    expect(isIpInCidr("192.168.107.0", "192.168.107.0/24")).toBe(true);
  });

  it("does not match IP outside /24 range", () => {
    expect(isIpInCidr("192.168.108.1", "192.168.107.0/24")).toBe(false);
    expect(isIpInCidr("10.0.0.1", "192.168.107.0/24")).toBe(false);
  });

  it("matches IP within /16 range", () => {
    expect(isIpInCidr("10.0.0.1", "10.0.0.0/16")).toBe(true);
    expect(isIpInCidr("10.0.255.255", "10.0.0.0/16")).toBe(true);
  });

  it("does not match IP outside /16 range", () => {
    expect(isIpInCidr("10.1.0.1", "10.0.0.0/16")).toBe(false);
  });

  it("matches with /32 explicit prefix (exact match)", () => {
    expect(isIpInCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(isIpInCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
  });

  it("matches everything with /0 prefix", () => {
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(isIpInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
  });

  it("handles IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)", () => {
    expect(isIpInCidr("::ffff:192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(isIpInCidr("192.168.1.1", "::ffff:192.168.1.0/24")).toBe(true);
    expect(isIpInCidr("::ffff:192.168.1.1", "::ffff:192.168.1.0/24")).toBe(true);
  });

  it("returns false for empty/undefined IP", () => {
    expect(isIpInCidr("", "192.168.1.0/24")).toBe(false);
    expect(isIpInCidr("  ", "192.168.1.0/24")).toBe(false);
  });

  it("returns false for invalid CIDR", () => {
    expect(isIpInCidr("192.168.1.1", "not-an-ip/24")).toBe(false);
    expect(isIpInCidr("192.168.1.1", "192.168.1.0/33")).toBe(false);
    expect(isIpInCidr("192.168.1.1", "192.168.1.0/-1")).toBe(false);
  });
});

describe("isTrustedProxyAddress with CIDR", () => {
  it("matches IP in a CIDR range from trustedProxies list", () => {
    expect(isTrustedProxyAddress("192.168.107.2", ["192.168.107.0/24"])).toBe(true);
  });

  it("does not match IP outside all CIDR ranges", () => {
    expect(isTrustedProxyAddress("10.0.0.1", ["192.168.107.0/24"])).toBe(false);
  });

  it("matches when any entry in the list matches", () => {
    expect(isTrustedProxyAddress("10.0.0.5", ["192.168.1.0/24", "10.0.0.0/8"])).toBe(true);
  });

  it("supports mix of exact IPs and CIDR ranges", () => {
    expect(isTrustedProxyAddress("172.16.0.1", ["192.168.1.1", "172.16.0.1"])).toBe(true);
    expect(isTrustedProxyAddress("172.16.0.2", ["192.168.1.1", "172.16.0.0/16"])).toBe(true);
  });

  it("returns false for undefined/empty inputs", () => {
    expect(isTrustedProxyAddress(undefined, ["192.168.1.0/24"])).toBe(false);
    expect(isTrustedProxyAddress("192.168.1.1", undefined)).toBe(false);
    expect(isTrustedProxyAddress("192.168.1.1", [])).toBe(false);
    expect(isTrustedProxyAddress(undefined, undefined)).toBe(false);
  });

  it("handles IPv4-mapped IPv6 proxy address", () => {
    expect(isTrustedProxyAddress("::ffff:192.168.107.5", ["192.168.107.0/24"])).toBe(true);
  });
});
