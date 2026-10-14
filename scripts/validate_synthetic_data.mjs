import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeReceipts } from "../analysis/masp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const orderFiles = [
  "pending-orders.json",
  "partially-delivered-orders.json",
  "fully-delivered-orders.json",
  "canceled-orders.json",
];
const statuses = new Set([
  "PENDING",
  "PARTIALLY_DELIVERED",
  "FULLY_DELIVERED",
  "CANCELED",
]);
const costRelations = new Set([
  "assumida_no_cenario",
  "nao_atribuida",
  "indeterminada",
]);

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
}

function isUtcInstant(value) {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function addIssue(issues, condition, message) {
  if (!condition) issues.push(message);
}

function uniqueValues(items, selector, name, issues) {
  const seen = new Set();
  for (const item of items) {
    const value = selector(item);
    if (typeof value !== "string" || !value) {
      issues.push(`${name} must be a non-empty string`);
    } else if (seen.has(value)) {
      issues.push(`duplicate ${name}: ${value}`);
    } else {
      seen.add(value);
    }
  }
}

function validateOrders(orders, issues) {
  uniqueValues(orders, (order) => order?.id, "order id", issues);
  uniqueValues(orders, (order) => order?.codigo, "order code", issues);
  const works = new Map();
  for (const order of orders) {
    addIssue(issues, statuses.has(order?.status), `invalid order status: ${order?.id ?? "unknown"}`);
    addIssue(issues, order?.siengeOperationalStatus === order?.status, `operational status mirror differs: ${order?.id ?? "unknown"}`);
    addIssue(issues, isUtcInstant(order?.dataEmissao), `invalid order emission date: ${order?.id ?? "unknown"}`);
    addIssue(issues, typeof order?.fornecedor === "string" && order.fornecedor.length > 0, `missing synthetic supplier: ${order?.id ?? "unknown"}`);
    addIssue(issues, Number.isFinite(order?.valorTotal) && order.valorTotal >= 0, `invalid order value: ${order?.id ?? "unknown"}`);
    addIssue(issues, typeof order?.obra?.id === "string" && typeof order?.obra?.nome === "string", `invalid work reference: ${order?.id ?? "unknown"}`);
    if (order?.obra?.id && order?.obra?.nome) {
      const previousName = works.get(order.obra.id);
      addIssue(issues, !previousName || previousName === order.obra.nome, `work id has inconsistent names: ${order.obra.id}`);
      works.set(order.obra.id, order.obra.nome);
    }
  }
  return works;
}

function validateCosts(costs, receiptIds, issues) {
  uniqueValues(costs, (cost) => cost?.id, "cost id", issues);
  for (const cost of costs) {
    addIssue(issues, receiptIds.has(cost?.receiptId), `cost references an unknown receipt: ${cost?.id ?? "unknown"}`);
    addIssue(issues, Number.isFinite(cost?.reworkMinutes) && cost.reworkMinutes >= 0, `invalid rework minutes: ${cost?.id ?? "unknown"}`);
    addIssue(issues, Number.isFinite(cost?.hourlyCostBRL) && cost.hourlyCostBRL >= 0, `invalid hourly cost: ${cost?.id ?? "unknown"}`);
    addIssue(issues, costRelations.has(cost?.delayRelation), `invalid cost delay relation: ${cost?.id ?? "unknown"}`);
    addIssue(issues, typeof cost?.assumptionJustification === "string" && cost.assumptionJustification.length > 0, `missing cost justification: ${cost?.id ?? "unknown"}`);
  }
}

function validateSummary(summary, orders, works, issues) {
  const countByStatus = Object.fromEntries([...statuses].map((status) => [status, orders.filter((order) => order.status === status).length]));
  const expected = {
    totalOrders: orders.length,
    pendingOrders: countByStatus.PENDING,
    approvedOrders: orders.filter((order) => order.siengeAuthorized === true).length,
    partiallyDeliveredOrders: countByStatus.PARTIALLY_DELIVERED,
    fullyDeliveredOrders: countByStatus.FULLY_DELIVERED,
    cancelledOrders: countByStatus.CANCELED,
    totalOrderValue: orders.reduce((total, order) => total + order.valorTotal, 0),
    pendingOrderValue: orders.filter((order) => order.status === "PENDING").reduce((total, order) => total + order.valorTotal, 0),
    totalWorks: works.size,
    totalCreditors: new Set(orders.map((order) => order.fornecedor)).size,
  };
  for (const [key, value] of Object.entries(expected)) {
    const matches = typeof value === "number"
      ? Math.abs((summary?.[key] ?? Number.NaN) - value) < 0.000001
      : summary?.[key] === value;
    addIssue(issues, matches, `summary mismatch for ${key}: expected ${value}, found ${summary?.[key]}`);
  }
}

function main() {
  const orders = orderFiles.flatMap(readJson);
  const receipts = readJson("receipts.json");
  const costs = readJson("rework-costs.json");
  const config = readJson("analysis-config.json");
  const metadata = readJson("extraction-metadata.json");
  const summary = readJson("summary.json");
  const issues = [];

  const works = validateOrders(orders, issues);
  uniqueValues(receipts, (receipt) => receipt?.id, "receipt id", issues);
  for (const receipt of receipts) {
    addIssue(issues, isUtcInstant(receipt?.receivedAt), `invalid receipt date: ${receipt?.id ?? "unknown"}`);
    addIssue(issues, receipt?.linkedAt === null || isUtcInstant(receipt?.linkedAt), `invalid linkage date: ${receipt?.id ?? "unknown"}`);
  }
  const result = analyzeReceipts({ orders, receipts, config });
  for (const issue of result.invalidReceipts) {
    issues.push(`invalid receipt ${issue.receiptId ?? "unknown"}: ${issue.issues.join("; ")}`);
  }
  validateCosts(costs, new Set(receipts.map((receipt) => receipt.id)), issues);
  validateSummary(summary, orders, works, issues);
  addIssue(issues, metadata?.nature === "synthetic" && metadata?.isRealExtraction === false && metadata?.sourceFile === null, "metadata must identify a synthetic dataset without source file linkage");
  addIssue(issues, metadata?.generatedQuantity?.orders === orders.length, "metadata order count differs from the dataset");
  addIssue(issues, metadata?.generatedQuantity?.receipts === receipts.length, "metadata receipt count differs from the dataset");
  addIssue(issues, metadata?.generatedQuantity?.works === works.size, "metadata work count differs from the dataset");

  const report = {
    valid: issues.length === 0,
    issues,
    counts: {
      orders: orders.length,
      receipts: receipts.length,
      costs: costs.length,
      works: works.size,
      validReceipts: result.completedLinkages + result.openReceipts,
      outOfScopeReceipts: result.outOfScopeReceipts.length,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (issues.length > 0) process.exitCode = 1;
}

main();
