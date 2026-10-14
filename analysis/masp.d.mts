export interface DurationResult { days: number | null; error: string | null }
export interface AgeResult { days: number | null; error: string | null }
export interface ParetoRow { obraId: string; obraName: string; count: number; percent: number; cumulativePercent: number }
export interface AnalysisIssue { type?: string; receiptId?: string | null; orderId?: string; field?: string; message?: string; issues?: string[]; excludedFromMetrics?: boolean }
export interface AnalysisResult {
  issues: AnalysisIssue[];
  invalidReceipts: AnalysisIssue[];
  outOfScopeReceipts: AnalysisIssue[];
  receiptValidation: (AnalysisIssue & { validationStatus: 'valid' | 'invalid' | 'out_of_scope' })[];
  denominators: { completedLinkages: number; openReceipts: number; lateLinkages: number };
  completedLinkages: number;
  openReceipts: number;
  completedWithinDeadline: number;
  lateLinkages: number;
  lateLinkagePercent: number;
  overdueOpenReceipts: number;
  openAges: { receiptId: string; ageDays: number | null }[];
  medianLinkageDays: number | null;
  paretoLateByWork: ParetoRow[];
  withinDeadlineRule: string;
}
export function calculateLinkageDuration(receipt: { receivedAt: string; linkedAt: string | null }): DurationResult;
export function calculateOpenAge(receipt: { receivedAt: string }, cutoffAt: string): AgeResult;
export function analyzeReceipts(input: { orders: unknown[]; receipts: Receipt[]; config: AnalysisConfig }): AnalysisResult;
export function paretoLateByWork(receipts: Receipt[], orders: Map<string, Order>): ParetoRow[];
export interface Receipt { id: string; orderId: string; receivedAt: string; linkedAt: string | null }
export interface Order { id: string; codigo: string; fornecedor: string; dataEmissao: string; valorTotal: number; status: string; obra: { id: string; nome: string } }
export interface AnalysisConfig { cutoffAt: string; linkageDeadlineDays: number }
