import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const scenario = JSON.parse(fs.readFileSync(path.join(dataDir, "synthetic-scenarios.json"), "utf8"));
const statusFiles = {
  PENDING: "pending-orders.json",
  PARTIALLY_DELIVERED: "partially-delivered-orders.json",
  FULLY_DELIVERED: "fully-delivered-orders.json",
  CANCELED: "canceled-orders.json",
};
const statusCodes = {
  PENDING: "PO",
  PARTIALLY_DELIVERED: "PD",
  FULLY_DELIVERED: "FD",
  CANCELED: "CA",
};

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pad(value, length = 4) {
  return String(value).padStart(length, "0");
}

function isoAt(day, hour = 0) {
  return new Date(Date.UTC(2025, 0, 1 + day, hour)).toISOString().replace(".000Z", ".000Z");
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  const random = createRandom(scenario.seed);
  const suppliers = Array.from(
    { length: scenario.supplierCount },
    (_, index) => `Fornecedor Sintético ${pad(index + 1, 3)}`,
  );
  const works = scenario.works.map((nome, index) => ({
    id: `SYN-W-${pad(index + 1, 3)}`,
    nome,
  }));
  const ordersByStatus = Object.fromEntries(Object.keys(statusFiles).map((status) => [status, []]));
  const orders = [];
  let orderNumber = 1;

  for (const [status, count] of Object.entries(scenario.ordersByStatus)) {
    for (let index = 0; index < count; index += 1) {
      const approved = random() < 0.72;
      const order = {
        id: `SYN-ORD-${pad(orderNumber)}`,
        codigo: `SYN-${statusCodes[status]}-${pad(orderNumber)}`,
        fornecedor: suppliers[(orderNumber - 1) % suppliers.length],
        valorTotal: Math.round((900 + random() * 14100) * 100) / 100,
        dataEmissao: isoAt((orderNumber * 3 + index) % 58),
        status,
        statusApproval: approved ? "APPROVED" : null,
        siengeOperationalStatus: status,
        siengeApprovalStatus: approved ? "APPROVED" : null,
        siengeAuthorized: approved,
        itens: [],
        obra: works[(orderNumber - 1) % works.length],
        nfe: null,
      };
      orders.push(order);
      ordersByStatus[status].push(order);
      orderNumber += 1;
    }
  }

  const eligibleOrders = orders.filter((order) => order.status !== "CANCELED");
  const receipts = [];
  let receiptNumber = 1;
  const addReceipt = (order, receivedDay, linkedAt) => {
    receipts.push({
      id: `SYN-REC-${pad(receiptNumber)}`,
      orderId: order.id,
      receivedAt: isoAt(receivedDay, 9),
      linkedAt,
    });
    receiptNumber += 1;
  };

  for (let index = 0; index < scenario.receipts.completed; index += 1) {
    const order = eligibleOrders[(index * 7) % eligibleOrders.length];
    const isLate = index < scenario.receipts.lateCompleted;
    const durationDays = isLate ? 4 + (index % 5) : 1 + (index % 3);
    const receivedDay = 60 + ((index * 5) % 20);
    addReceipt(order, receivedDay, isoAt(receivedDay + durationDays, 9));
  }
  for (let index = 0; index < scenario.receipts.open; index += 1) {
    const order = eligibleOrders[(index * 11 + 3) % eligibleOrders.length];
    const overdue = index < scenario.receipts.overdueOpen;
    addReceipt(order, overdue ? 65 + (index % 10) : 87 + (index % 3), null);
  }

  const costs = Array.from({ length: scenario.costRecordCount }, (_, index) => {
    const relation = index % 3 === 0
      ? "nao_atribuida"
      : index % 5 === 0
        ? "indeterminada"
        : "assumida_no_cenario";
    return {
      id: `SYN-COST-${pad(index + 1)}`,
      receiptId: receipts[(index * 7 + 1) % receipts.length].id,
      description: [
        "Conferência adicional de documentação",
        "Regularização simulada de cadastro",
        "Revisão acadêmica de vínculo",
      ][index % 3],
      reworkMinutes: 15 + (index % 5) * 15,
      hourlyCostBRL: 65 + (index % 4) * 15,
      delayRelation: relation,
      assumptionJustification: "Premissa didática de atividade adicional; não comprova causa, tarifa ou prejuízo real.",
    };
  });

  for (const [status, filename] of Object.entries(statusFiles)) writeJson(filename, ordersByStatus[status]);
  writeJson("receipts.json", receipts);
  writeJson("rework-costs.json", costs);

  const totalOrderValue = orders.reduce((total, order) => total + order.valorTotal, 0);
  const pendingOrders = ordersByStatus.PENDING;
  writeJson("summary.json", {
    totalOrders: orders.length,
    pendingOrders: pendingOrders.length,
    approvedOrders: orders.filter((order) => order.siengeAuthorized).length,
    rejectedOrders: 0,
    partiallyDeliveredOrders: ordersByStatus.PARTIALLY_DELIVERED.length,
    fullyDeliveredOrders: ordersByStatus.FULLY_DELIVERED.length,
    cancelledOrders: ordersByStatus.CANCELED.length,
    totalOrderValue,
    pendingOrderValue: pendingOrders.reduce((total, order) => total + order.valorTotal, 0),
    averageTicket: totalOrderValue / orders.length,
    totalNfes: 0,
    totalNfeValue: 0,
    totalWorks: works.length,
    totalTeams: 3,
    totalCompanies: 1,
    totalCollaborators: 12,
    totalCreditors: suppliers.length,
  });
  writeJson("extraction-metadata.json", {
    nature: "synthetic",
    purpose: "academic MASP demonstration with deterministic scenarios",
    isRealExtraction: false,
    sourceFile: null,
    processingDate: "2026-10-14",
    extractionDate: null,
    filters: null,
    period: { start: "2025-01-01T00:00:00.000Z", end: scenario.cutoffAt },
    generatedQuantity: {
      orders: orders.length,
      receipts: receipts.length,
      works: works.length,
      suppliers: suppliers.length,
      teams: 3,
      companies: 1,
      collaborators: 12,
    },
    generationRules: [
      "Use only synthetic identifiers, names, dates and monetary values.",
      "Use the scenario specification and seed to reproduce this dataset.",
      "Keep operational status separate from approval status.",
      "Do not create receipts for canceled orders.",
      "No correspondence table between source and synthetic records exists.",
    ],
    pagesFound: null,
    declaredTotals: null,
    duplicates: { identicalRemoved: [], repeatedIds: [] },
    conflicts: [],
    completeness: {
      pending: "complete",
      partiallyDelivered: "complete",
      fullyDelivered: "complete",
      canceled: "complete",
    },
    statusDimensions: {
      operationalStatusField: "status",
      operationalStatusMirror: "siengeOperationalStatus",
      approvalFields: ["statusApproval", "siengeApprovalStatus", "siengeAuthorized"],
    },
    archiveExcludedFromVersioning: true,
    documentation: "docs/synthetic-data-schema.md",
    qualityNotes: [
      "This dataset is synthetic and must not be presented as an ERP extraction.",
      "No direct identifier or record-level value from an ERP is retained.",
    ],
  });
}

main();
