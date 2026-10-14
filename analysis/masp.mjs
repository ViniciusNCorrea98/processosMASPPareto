const DAY_MS = 24 * 60 * 60 * 1000;

function parseInstant(value) {
  if (typeof value !== "string" || !value.endsWith("Z")) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function calculateLinkageDuration(receipt) {
  const received = parseInstant(receipt?.receivedAt);
  const linked = parseInstant(receipt?.linkedAt);
  if (received === null || linked === null) {
    return {
      days: null,
      error: "receivedAt and linkedAt must be valid UTC instants",
    };
  }
  if (linked < received) {
    return { days: null, error: "linkedAt must not precede receivedAt" };
  }
  return { days: (linked - received) / DAY_MS, error: null };
}

function calculateOpenAge(receipt, cutoffAt) {
  const received = parseInstant(receipt?.receivedAt);
  const cutoff = parseInstant(cutoffAt);
  if (received === null || cutoff === null) {
    return {
      days: null,
      error: "receivedAt and cutoffAt must be valid UTC instants",
    };
  }
  if (received > cutoff) {
    return { days: null, error: "receivedAt must not be after cutoffAt" };
  }
  return { days: (cutoff - received) / DAY_MS, error: null };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function validateInputs(orders, receipts, config) {
  const issues = [];
  const orderById = new Map();
  const seenReceiptIds = new Set();
  for (const order of orders) {
    if (!order || typeof order.id !== "string") {
      issues.push({
        type: "invalid_order",
        message: "order.id must be a string",
      });
      continue;
    }
    if (orderById.has(order.id))
      issues.push({ type: "duplicate_order_id", orderId: order.id });
    if (parseInstant(order.dataEmissao) === null) {
      issues.push({
        type: "invalid_order_emission_date",
        orderId: order.id,
        field: "dataEmissao",
      });
    }
    orderById.set(order.id, order);
  }
  const cutoff = parseInstant(config?.cutoffAt);
  if (cutoff === null)
    issues.push({ type: "invalid_config", field: "cutoffAt" });
  if (
    !Number.isInteger(config?.linkageDeadlineDays) ||
    config.linkageDeadlineDays < 0
  ) {
    issues.push({ type: "invalid_config", field: "linkageDeadlineDays" });
  }
  const validReceipts = [];
  const invalidReceipts = [];
  const outOfScopeReceipts = [];
  const receiptValidation = [];
  for (const receipt of receipts) {
    const receiptIssues = [];
    if (!receipt || typeof receipt.id !== "string")
      receiptIssues.push("id must be a string");
    if (receipt?.id && seenReceiptIds.has(receipt.id))
      receiptIssues.push("duplicate receipt id");
    if (receipt?.id) seenReceiptIds.add(receipt.id);
    if (typeof receipt?.orderId !== "string" || !orderById.has(receipt.orderId))
      receiptIssues.push("order reference does not exist");
    else if (orderById.get(receipt.orderId).status === "CANCELED")
      receiptIssues.push("receipts for canceled orders are not supported");
    if (parseInstant(receipt?.receivedAt) === null)
      receiptIssues.push("receivedAt is invalid or lacks explicit UTC Z");
    if (
      receipt?.orderId &&
      orderById.has(receipt.orderId) &&
      parseInstant(receipt?.receivedAt) !== null &&
      parseInstant(orderById.get(receipt.orderId).dataEmissao) !== null &&
      parseInstant(receipt.receivedAt) <
        parseInstant(orderById.get(receipt.orderId).dataEmissao)
    ) {
      receiptIssues.push("receivedAt must not precede order dataEmissao");
    }
    if (receipt?.linkedAt !== null && parseInstant(receipt?.linkedAt) === null)
      receiptIssues.push("linkedAt is invalid or lacks explicit UTC Z");
    if (receipt?.linkedAt !== null) {
      const duration = calculateLinkageDuration(receipt);
      if (duration.error) receiptIssues.push(duration.error);
    }
    if (receiptIssues.length > 0) {
      const issue = {
        receiptId: receipt?.id ?? null,
        issues: receiptIssues,
        excludedFromMetrics: true,
        validationStatus: "invalid",
      };
      invalidReceipts.push(issue);
      receiptValidation.push(issue);
    } else if (cutoff !== null && parseInstant(receipt.receivedAt) > cutoff) {
      const issue = {
        receiptId: receipt.id,
        issues: [
          "receivedAt is after cutoffAt; event is outside the temporal scope",
        ],
        excludedFromMetrics: true,
        validationStatus: "out_of_scope",
      };
      outOfScopeReceipts.push(issue);
      receiptValidation.push(issue);
    } else {
      validReceipts.push(receipt);
      receiptValidation.push({
        receiptId: receipt.id,
        issues: [],
        excludedFromMetrics: false,
        validationStatus: "valid",
      });
    }
  }
  return {
    orderById,
    validReceipts,
    invalidReceipts,
    outOfScopeReceipts,
    receiptValidation,
    issues,
    cutoff,
  };
}

function paretoLateByWork(lateReceipts, orderById) {
  if (lateReceipts.length === 0) return [];
  const grouped = new Map();
  for (const receipt of lateReceipts) {
    const work = orderById.get(receipt.orderId).obra;
    const key = work.id;
    const current = grouped.get(key) ?? {
      obraId: key,
      obraName: work.nome,
      count: 0,
    };
    current.count += 1;
    grouped.set(key, current);
  }
  const total = lateReceipts.length;
  let cumulative = 0;
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || a.obraId.localeCompare(b.obraId))
    .map((row) => {
      const percent = (row.count / total) * 100;
      cumulative += percent;
      return { ...row, percent, cumulativePercent: cumulative };
    });
}

function analyzeReceipts({ orders, receipts, config }) {
  const checked = validateInputs(orders, receipts, config);
  const valid = checked.validReceipts;
  const completed = valid.filter((receipt) => receipt.linkedAt !== null);
  const open = valid.filter((receipt) => receipt.linkedAt === null);
  const completedWithDuration = completed.map((receipt) => ({
    receipt,
    result: calculateLinkageDuration(receipt),
  }));
  const withinDeadline = completedWithDuration.filter(
    ({ result }) => result.days <= config.linkageDeadlineDays
  );
  const late = completedWithDuration
    .filter(({ result }) => result.days > config.linkageDeadlineDays)
    .map(({ receipt }) => receipt);
  const overdueOpen = open.filter(
    (receipt) =>
      calculateOpenAge(receipt, config.cutoffAt).days >
      config.linkageDeadlineDays
  );
  const ages = open.map((receipt) => ({
    receipt,
    result: calculateOpenAge(receipt, config.cutoffAt),
  }));
  return {
    issues: [
      ...checked.issues,
      ...checked.invalidReceipts,
      ...checked.outOfScopeReceipts,
    ],
    invalidReceipts: checked.invalidReceipts,
    outOfScopeReceipts: checked.outOfScopeReceipts,
    receiptValidation: checked.receiptValidation,
    denominators: {
      completedLinkages: completed.length,
      openReceipts: open.length,
      lateLinkages: completed.length,
    },
    completedLinkages: completed.length,
    openReceipts: open.length,
    completedWithinDeadline: withinDeadline.length,
    lateLinkages: late.length,
    lateLinkagePercent:
      completed.length === 0 ? 0 : (late.length / completed.length) * 100,
    overdueOpenReceipts: overdueOpen.length,
    openAges: ages.map(({ receipt, result }) => ({
      receiptId: receipt.id,
      ageDays: result.days,
    })),
    medianLinkageDays: median(
      completedWithDuration.map(({ result }) => result.days)
    ),
    paretoLateByWork: paretoLateByWork(late, checked.orderById),
    withinDeadlineRule:
      "linked durationDays <= linkageDeadlineDays; open receipts are excluded from completed-linkage metrics",
  };
}

export {
  calculateLinkageDuration,
  calculateOpenAge,
  median,
  analyzeReceipts,
  paretoLateByWork,
};
