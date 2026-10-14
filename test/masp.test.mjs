import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateLinkageDuration,
  calculateOpenAge,
  analyzeReceipts,
} from "../analysis/masp.mjs";

const config = { cutoffAt: "2025-04-01T00:00:00.000Z", linkageDeadlineDays: 3 };
const orders = [
  {
    id: "O-1",
    status: "PENDING",
    dataEmissao: "2025-01-01T00:00:00.000Z",
    obra: { id: "W-1", nome: "Work 1" },
  },
  {
    id: "O-2",
    status: "PARTIALLY_DELIVERED",
    dataEmissao: "2025-01-01T00:00:00.000Z",
    obra: { id: "W-2", nome: "Work 2" },
  },
  {
    id: "O-3",
    status: "PENDING",
    dataEmissao: "2025-01-01T00:00:00.000Z",
    obra: { id: "W-3", nome: "Work 3" },
  },
];

test("deadline boundaries: within, exact limit, and late", () => {
  assert.equal(
    calculateLinkageDuration({
      receivedAt: "2025-03-01T00:00:00.000Z",
      linkedAt: "2025-03-04T00:00:00.000Z",
    }).days,
    3
  );
  assert.equal(
    calculateLinkageDuration({
      receivedAt: "2025-03-01T00:00:00.000Z",
      linkedAt: "2025-03-04T00:00:00.001Z",
    }).days > 3,
    true
  );
  assert.equal(
    calculateLinkageDuration({
      receivedAt: "2025-03-01T00:00:00.000Z",
      linkedAt: "2025-03-03T00:00:00.000Z",
    }).days <= 3,
    true
  );
});

test("multiple receipts for one order remain separate", () => {
  const result = analyzeReceipts({
    orders,
    config,
    receipts: [
      {
        id: "R-1",
        orderId: "O-1",
        receivedAt: "2025-03-01T00:00:00.000Z",
        linkedAt: "2025-03-02T00:00:00.000Z",
      },
      {
        id: "R-2",
        orderId: "O-1",
        receivedAt: "2025-03-03T00:00:00.000Z",
        linkedAt: null,
      },
    ],
  });
  assert.equal(result.completedLinkages, 1);
  assert.equal(result.openReceipts, 1);
});

test("invalid dates and references are reported, not repaired", () => {
  const result = analyzeReceipts({
    orders,
    config,
    receipts: [
      {
        id: "R-bad-date",
        orderId: "O-1",
        receivedAt: "not-a-date",
        linkedAt: null,
      },
      {
        id: "R-bad-ref",
        orderId: "O-missing",
        receivedAt: "2025-03-01T00:00:00.000Z",
        linkedAt: null,
      },
      {
        id: "R-reversed",
        orderId: "O-1",
        receivedAt: "2025-03-04T00:00:00.000Z",
        linkedAt: "2025-03-03T00:00:00.000Z",
      },
    ],
  });
  assert.equal(result.invalidReceipts.length, 3);
  assert.equal(result.completedLinkages, 0);
});

test("open age uses the fixed cutoff and empty sets return null or zero", () => {
  assert.equal(
    calculateOpenAge(
      { receivedAt: "2025-03-29T00:00:00.000Z" },
      config.cutoffAt
    ).days,
    3
  );
  const empty = analyzeReceipts({ orders, config, receipts: [] });
  assert.equal(empty.lateLinkagePercent, 0);
  assert.equal(empty.medianLinkageDays, null);
  assert.deepEqual(empty.paretoLateByWork, []);
});

test("canceled orders and duplicate receipt IDs are flagged", () => {
  const result = analyzeReceipts({
    orders: [{ ...orders[0], status: "CANCELED" }],
    config,
    receipts: [
      {
        id: "R-dup",
        orderId: "O-1",
        receivedAt: "2025-03-01T00:00:00.000Z",
        linkedAt: null,
      },
      {
        id: "R-dup",
        orderId: "O-1",
        receivedAt: "2025-03-01T00:00:00.000Z",
        linkedAt: null,
      },
    ],
  });
  assert.equal(result.invalidReceipts.length, 2);
});

test("emission and cutoff boundaries distinguish invalid from out of scope", () => {
  const result = analyzeReceipts({
    orders,
    config,
    receipts: [
      {
        id: "R-before-emission",
        orderId: "O-1",
        receivedAt: "2024-12-31T00:00:00.000Z",
        linkedAt: null,
      },
      {
        id: "R-after-cutoff",
        orderId: "O-1",
        receivedAt: "2025-04-02T00:00:00.000Z",
        linkedAt: null,
      },
      {
        id: "R-cutoff",
        orderId: "O-1",
        receivedAt: "2025-04-01T00:00:00.000Z",
        linkedAt: null,
      },
    ],
  });
  assert.equal(
    result.invalidReceipts.some(
      (issue) => issue.receiptId === "R-before-emission"
    ),
    true
  );
  assert.equal(
    result.outOfScopeReceipts.some(
      (issue) => issue.receiptId === "R-after-cutoff"
    ),
    true
  );
  assert.equal(
    result.receiptValidation.find((item) => item.receiptId === "R-cutoff")
      .validationStatus,
    "valid"
  );
});

test("pareto uses all eligible late events, stable work-id tie break, and empty/single sets", () => {
  const receipts = [
    {
      id: "R-north",
      orderId: "O-1",
      receivedAt: "2025-03-01T00:00:00.000Z",
      linkedAt: "2025-03-05T00:00:00.000Z",
    },
    {
      id: "R-south",
      orderId: "O-2",
      receivedAt: "2025-03-01T00:00:00.000Z",
      linkedAt: "2025-03-05T00:00:00.000Z",
    },
    {
      id: "R-center",
      orderId: "O-3",
      receivedAt: "2025-03-10T00:00:00.000Z",
      linkedAt: "2025-03-14T00:00:00.000Z",
    },
  ];
  const twoDays = { ...config, linkageDeadlineDays: 2 };
  const result = analyzeReceipts({ orders, config: twoDays, receipts });
  assert.equal(result.lateLinkages, 3);
  assert.deepEqual(
    result.paretoLateByWork.map((row) => row.count),
    [1, 1, 1]
  );
  assert.deepEqual(
    result.paretoLateByWork.map(
      (row) => Math.round(row.cumulativePercent * 100) / 100
    ),
    [33.33, 66.67, 100]
  );
  assert.equal(
    analyzeReceipts({ orders, config, receipts: [] }).paretoLateByWork.length,
    0
  );
  assert.equal(
    analyzeReceipts({ orders, config: twoDays, receipts: [receipts[0]] })
      .paretoLateByWork[0].cumulativePercent,
    100
  );
});
