// WHO IS A SCOPED FLOOR ROLE, decided once, on the server.
//
// THIS FILE EXISTS BECAUSE THE OLD RULE WAS LIVE AND WRONG. The clients decided
// the waiter scoping themselves by asking whether every role string was
// literally "waiter". Two ordinary configurations defeated it, and both were
// invisible — the app behaved correctly on one tenant and wrongly on the next:
//
//   * a waiter granted any CUSTOM ROLE carries its UUID in role_all, which is
//     not the word "waiter", so every restriction lifted — including the money
//     gate, since showsMoney was defined as !isWaiterOnly;
//   * "employee" is parseEmployeeRoles's FALLBACK for an unset primary and is
//     always folded into role_all, so a half-configured record un-scoped itself.
//
// The first two tests below are those two tenants. They are the regression.
import { describe, test, expect } from "@jest/globals";
import { isWaiterOnly, sessionRoleScope, isCoreRole, ROLES_OUTRANKING_WAITER } from "../role_scope";

const CUSTOM_ROLE_ID = "d2b1f0c4-5a97-4e40-b8d3-7e02a9c4f156";

describe("the two shapes that were live in production", () => {
  test("a waiter with a CUSTOM ROLE is still a waiter", () => {
    // The RBAC feature's own output. Using it must not hand the floor the house.
    expect(isWaiterOnly({ role: "waiter", role_all: ["waiter", CUSTOM_ROLE_ID], actions: ["a1"] })).toBe(true);
  });

  test('a waiter carrying the "employee" fallback is still a waiter', () => {
    expect(isWaiterOnly({ role: "employee", role_all: ["employee", "waiter"], actions: ["a1"] })).toBe(true);
    expect(isWaiterOnly({ role: "waiter", role_all: ["waiter", "employee"], actions: ["a1"] })).toBe(true);
  });

  test("several custom roles, still a waiter", () => {
    const many = ["waiter", CUSTOM_ROLE_ID, "8f0a1b2c-3d4e-4f50-9a6b-7c8d9e0f1a2b", "employee"];
    expect(isWaiterOnly({ role: "waiter", role_all: many, actions: ["a1"] })).toBe(true);
  });
});

describe("what DOES lift the scoping", () => {
  test("a role that outranks a waiter, and only those", () => {
    for (const senior of ROLES_OUTRANKING_WAITER) {
      expect(isWaiterOnly({ role: "waiter", role_all: ["waiter", senior], actions: ["a1"] }))
        .toBe(false);
    }
  });

  test("the admin wildcard, whatever the roles say", () => {
    expect(isWaiterOnly({ role: "waiter", role_all: ["waiter"], actions: ["*"] })).toBe(false);
  });

  test("a valet does NOT outrank a waiter", () => {
    // A valet is a scoped role of its own, not a supervisor, and has never been
    // the reason anybody sees money.
    expect(isWaiterOnly({ role: "waiter", role_all: ["waiter", "valet"], actions: ["a1"] })).toBe(true);
  });
});

describe("who is not a waiter at all", () => {
  test("somebody with no waiter role is not scoped by this predicate", () => {
    expect(isWaiterOnly({ role: "employee", role_all: ["employee"], actions: ["a1"] })).toBe(false);
    expect(isWaiterOnly({ role: "valet", role_all: ["valet"], actions: ["a1"] })).toBe(false);
    expect(isWaiterOnly({ role: "manager", role_all: ["manager"], actions: ["a1"] })).toBe(false);
  });
});

describe("it fails in the safe direction", () => {
  // Being wrong here must mean "an owner still sees everything", never "a waiter
  // lost the screen they work from". A floor that cannot take an order is a
  // worse outage than a figure on a screen.
  test("an empty, missing or unreadable role set is NOT scoped", () => {
    expect(isWaiterOnly({})).toBe(false);
    expect(isWaiterOnly({ role: "", role_all: [], actions: [] })).toBe(false);
    expect(isWaiterOnly({ role: null, role_all: null, actions: null })).toBe(false);
    expect(isWaiterOnly({ role: 42, role_all: "waiter", actions: 7 })).toBe(false);
  });

  test("casing and padding cannot change the answer", () => {
    expect(isWaiterOnly({ role: "  WAITER ", role_all: ["Waiter"], actions: ["a1"] })).toBe(true);
    expect(isWaiterOnly({ role: "waiter", role_all: ["  Manager  "], actions: ["a1"] })).toBe(false);
  });
});

describe("the wire", () => {
  test("sessionRoleScope is what the clients obey", () => {
    expect(sessionRoleScope({ role: "waiter", role_all: ["waiter", CUSTOM_ROLE_ID], actions: ["a1"] }))
      .toEqual({ waiter_only: true });
    expect(sessionRoleScope({ role: "admin", role_all: ["admin"], actions: ["*"] }))
      .toEqual({ waiter_only: false });
  });

  test("a custom role id is not mistaken for a core role", () => {
    expect(isCoreRole(CUSTOM_ROLE_ID)).toBe(false);
    expect(isCoreRole("waiter")).toBe(true);
    expect(isCoreRole("MANAGER")).toBe(true);
  });
});
