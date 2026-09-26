import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import {
  couponProblem,
  financialYear,
  formatRupees,
  gstBreakup,
  priceWith,
  renderInvoicePdf,
} from "../src/index.js";

describe("priceWith", () => {
  it("applies percent and flat coupons", () => {
    expect(priceWith(49900, { kind: "percent", percent: 20, flatPaise: null })).toEqual({
      pricePaise: 49900,
      discountPaise: 9980,
      amountPaise: 39920,
    });
    expect(priceWith(49900, { kind: "flat", percent: null, flatPaise: 10000 }).amountPaise).toBe(
      39900,
    );
  });
  it("never goes below ₹1 unless the coupon is 100 %", () => {
    expect(priceWith(49900, { kind: "flat", percent: null, flatPaise: 49850 }).amountPaise).toBe(
      100,
    );
    expect(priceWith(49900, { kind: "percent", percent: 100, flatPaise: null }).amountPaise).toBe(
      0,
    );
    expect(priceWith(49900, { kind: "flat", percent: null, flatPaise: 99999 }).amountPaise).toBe(0);
  });
});

describe("gstBreakup", () => {
  it("splits an inclusive amount into taxable + CGST + SGST that add up exactly", () => {
    for (const amount of [100, 49900, 99900, 12345, 1]) {
      const g = gstBreakup(amount);
      expect(g.taxablePaise + g.cgstPaise + g.sgstPaise + g.igstPaise).toBe(amount);
      expect(Math.abs(g.cgstPaise - g.sgstPaise)).toBeLessThanOrEqual(1);
    }
    expect(gstBreakup(11800)).toEqual({
      taxablePaise: 10000,
      cgstPaise: 900,
      sgstPaise: 900,
      igstPaise: 0,
    });
    expect(gstBreakup(11800, true).igstPaise).toBe(1800);
  });
});

describe("financialYear", () => {
  it("runs April to March in IST", () => {
    expect(financialYear(new Date("2026-04-01T00:00:00+05:30"))).toBe("2026-27");
    expect(financialYear(new Date("2026-03-31T23:59:00+05:30"))).toBe("2025-26");
    // 31 Mar 20:00 UTC is already 1 Apr in India.
    expect(financialYear(new Date("2027-03-31T20:00:00Z"))).toBe("2027-28");
    expect(financialYear(new Date("2099-12-01T00:00:00Z"))).toBe("2099-00");
  });
});

describe("couponProblem", () => {
  const base = {
    kind: "percent" as const,
    percent: 10,
    flatPaise: null,
    maxUses: 5,
    uses: 0,
    perUserLimit: 1,
    expiresAt: null,
    planIds: [] as Types.ObjectId[],
    active: true,
    ownerUserId: null,
  };
  const userId = new Types.ObjectId().toString();
  const planId = new Types.ObjectId().toString();
  const ctx = { userId, planId, usedByUser: 0 };

  it("accepts a valid coupon and explains every rejection", () => {
    expect(couponProblem(base, ctx)).toBeNull();
    expect(couponProblem({ ...base, active: false }, ctx)).toMatch(/active/);
    expect(couponProblem({ ...base, expiresAt: new Date(Date.now() - 1000) }, ctx)).toMatch(
      /expired/,
    );
    expect(couponProblem({ ...base, uses: 5 }, ctx)).toMatch(/fully used/);
    expect(couponProblem(base, { ...ctx, usedByUser: 1 })).toMatch(/already used/);
    expect(couponProblem({ ...base, planIds: [new Types.ObjectId()] }, ctx)).toMatch(/plan/);
    expect(couponProblem({ ...base, planIds: [new Types.ObjectId(planId)] }, ctx)).toBeNull();
    expect(couponProblem({ ...base, ownerUserId: new Types.ObjectId() }, ctx)).toMatch(
      /another account/,
    );
  });
});

describe("renderInvoicePdf", () => {
  it("renders a PDF with Indian number formatting", async () => {
    expect(formatRupees(123456789)).toBe("Rs. 12,34,567.89");
    const pdf = await renderInvoicePdf(
      {
        kind: "invoice",
        number: "MP/2026-27/000001",
        date: new Date(),
        description: "SSC CGL Series — 365 days access",
        amountPaise: 49900,
        ...gstBreakup(49900),
        customer: { name: "राम Kumar", email: "a@b.in", phone: "" },
      },
      { name: "mockprep", address: "1 Street, City", gstin: "", state: "Delhi (07)", email: "" },
    );
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
