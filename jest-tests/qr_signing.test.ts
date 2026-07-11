import { describe, test, expect } from "@jest/globals";
import { signTable, verifyTable, encodeTableToken, decodeTableToken } from "../qr_signing";

const RES = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("qr_signing", () => {
  test("signTable is deterministic and verifies its own signature", () => {
    const sig = signTable(RES, "Table 5");
    expect(typeof sig).toBe("string");
    expect(sig.length).toBe(16);
    expect(signTable(RES, "Table 5")).toBe(sig); // deterministic
    expect(verifyTable(RES, "Table 5", sig)).toBe(true);
  });

  test("table name is normalized (case- and whitespace-insensitive)", () => {
    expect(signTable(RES, "Table 5")).toBe(signTable(RES, "  table 5  "));
    expect(verifyTable(RES, "  TABLE 5 ", signTable(RES, "table 5"))).toBe(true);
  });

  test("a different restaurant cannot reuse another's signature (tenant binding)", () => {
    const sig = signTable(RES, "Table 5");
    expect(verifyTable(OTHER, "Table 5", sig)).toBe(false);
  });

  test("verifyTable rejects a tampered table, sig, or empty inputs", () => {
    const sig = signTable(RES, "Table 5");
    expect(verifyTable(RES, "Table 6", sig)).toBe(false);
    expect(verifyTable(RES, "Table 5", sig.slice(0, -1) + "x")).toBe(false);
    expect(verifyTable(RES, "Table 5", "")).toBe(false);
    expect(verifyTable(RES, "", sig)).toBe(false);
    expect(verifyTable("", "Table 5", sig)).toBe(false);
    // length mismatch must not throw (timingSafeEqual guard)
    expect(verifyTable(RES, "Table 5", "short")).toBe(false);
  });

  test("encode/decode token round-trips and hides the plain table name", () => {
    const token = encodeTableToken(RES, "Patio 12");
    expect(token).not.toContain("Patio 12"); // name is base64url-encoded
    expect(decodeTableToken(RES, token)).toBe("Patio 12");
  });

  test("decodeTableToken rejects a tampered or malformed token", () => {
    const token = encodeTableToken(RES, "Patio 12");
    const [name64, sig] = token.split(".");
    if (!name64 || !sig) throw new Error("token did not have the expected name.sig shape");
    // wrong restaurant
    expect(decodeTableToken(OTHER, token)).toBeNull();
    // tampered signature
    expect(decodeTableToken(RES, `${name64}.${sig.slice(0, -1)}z`)).toBeNull();
    // swapped table name (re-encoded) keeps the old sig -> fails
    const evil = Buffer.from("Patio 99").toString("base64url");
    expect(decodeTableToken(RES, `${evil}.${sig}`)).toBeNull();
    // malformed
    expect(decodeTableToken(RES, "no-dot")).toBeNull();
    expect(decodeTableToken(RES, "")).toBeNull();
  });
});
