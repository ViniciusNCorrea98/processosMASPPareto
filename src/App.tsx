import { useMemo, useState } from "react";
import pendingOrders from "../data/pending-orders.json";
import partialOrders from "../data/partially-delivered-orders.json";
import fullOrders from "../data/fully-delivered-orders.json";
import canceledOrders from "../data/canceled-orders.json";
import receiptsData from "../data/receipts.json";
import configData from "../data/analysis-config.json";
import {
  analyzeReceipts,
  calculateLinkageDuration,
  calculateOpenAge,
  type AnalysisResult,
  type Order,
  type Receipt,
} from "../analysis/masp.mjs";

const orders = [
  ...pendingOrders,
  ...partialOrders,
  ...fullOrders,
  ...canceledOrders,
] as Order[];
const receipts = receiptsData as Receipt[];
const config = configData as {
  cutoffAt: string;
  linkageDeadlineDays: number;
  timeUnit: string;
  dateConvention: string;
};

function formatDate(value: string | null) {
  if (!value) return "Não vinculado";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    dateStyle: "short",
  }).format(new Date(value));
}

function formatDays(value: number | null) {
  return value === null || Number.isNaN(value)
    ? "Não disponível"
    : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} d`;
}

function formatPercent(value: number) {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function classify(receipt: Receipt, result: AnalysisResult) {
  const issue = result.invalidReceipts.find(
    (item) => item.receiptId === receipt.id
  );
  if (issue) return { label: "Dados inválidos", tone: "invalid" };
  if (receipt.linkedAt) {
    const duration = calculateLinkageDuration(receipt).days;
    return duration !== null && duration <= config.linkageDeadlineDays
      ? { label: "Dentro do prazo", tone: "good" }
      : { label: "Fora do prazo", tone: "late" };
  }
  const age = calculateOpenAge(receipt, config.cutoffAt).days;
  return age !== null && age > config.linkageDeadlineDays
    ? { label: "Aberto vencido", tone: "late" }
    : { label: "Aberto no prazo", tone: "open" };
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function ParetoChart({ rows }: { rows: AnalysisResult["paretoLateByWork"] }) {
  const width = 680;
  const height = 310;
  const plot = { left: 58, top: 24, right: 58, bottom: 70 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const maxCount = Math.max(...rows.map((row) => row.count), 1);
  const bandWidth = plotWidth / rows.length;
  const countTicks =
    maxCount <= 5
      ? Array.from({ length: maxCount + 1 }, (_, index) => index)
      : [
          ...new Set([
            0,
            Math.round(maxCount * 0.25),
            Math.round(maxCount * 0.5),
            Math.round(maxCount * 0.75),
            maxCount,
          ]),
        ];
  const yForCount = (count: number) =>
    plot.top + plotHeight - (count / maxCount) * plotHeight;
  const yForPercent = (percent: number) =>
    plot.top + plotHeight - (percent / 100) * plotHeight;
  const points = rows
    .map((row, index) => {
      const x = plot.left + bandWidth * (index + 0.5);
      return `${x},${yForPercent(row.cumulativePercent)}`;
    })
    .join(" ");

  return (
    <div className="pareto-visual-wrap">
      <div
        className="pareto-legend"
        role="group"
        aria-label="Legenda do gráfico"
      >
        <span>
          <i className="legend-column" aria-hidden="true" /> Ocorrências
        </span>
        <span>
          <i className="legend-cumulative" aria-hidden="true" /> Percentual
          acumulado
        </span>
        <span>
          <i className="legend-reference" aria-hidden="true" /> Referência de
          80%
        </span>
      </div>
      <svg
        className="pareto-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby="pareto-title pareto-description"
      >
        <title id="pareto-title">
          Pareto de vínculos concluídos fora do prazo por obra
        </title>
        <desc id="pareto-description">
          Colunas mostram ocorrências no eixo esquerdo. A linha mostra o
          percentual acumulado no eixo direito, com referência em 80 por cento.
        </desc>
        {countTicks.map((count) => {
          const y = yForCount(count);
          return (
            <g key={`count-${count}`}>
              <line
                className="chart-grid"
                x1={plot.left}
                x2={width - plot.right}
                y1={y}
                y2={y}
              />
              <text
                className="axis-label left-axis-label"
                x={plot.left - 10}
                y={y + 4}
                textAnchor="end"
              >
                {count}
              </text>
            </g>
          );
        })}
        {[0, 20, 40, 60, 80, 100].map((percent) => {
          const y = yForPercent(percent);
          return (
            <text
              className="axis-label right-axis-label"
              key={`percent-${percent}`}
              x={width - plot.right + 10}
              y={y + 4}
            >
              {percent}%
            </text>
          );
        })}
        <line
          className="axis-line"
          x1={plot.left}
          x2={plot.left}
          y1={plot.top}
          y2={plot.top + plotHeight}
        />
        <line
          className="axis-line"
          x1={width - plot.right}
          x2={width - plot.right}
          y1={plot.top}
          y2={plot.top + plotHeight}
        />
        <line
          className="axis-line"
          x1={plot.left}
          x2={width - plot.right}
          y1={plot.top + plotHeight}
          y2={plot.top + plotHeight}
        />
        <line
          className="reference-line"
          x1={plot.left}
          x2={width - plot.right}
          y1={yForPercent(80)}
          y2={yForPercent(80)}
        />
        {rows.map((row, index) => {
          const center = plot.left + bandWidth * (index + 0.5);
          const barWidth = Math.max(22, bandWidth * 0.58);
          const barY = yForCount(row.count);
          return (
            <g key={row.obraId}>
              <rect
                className="pareto-bar"
                x={center - barWidth / 2}
                y={barY}
                width={barWidth}
                height={plot.top + plotHeight - barY}
                rx="4"
              >
                <title>{`${row.obraName}: ${row.count} ocorrência(s)`}</title>
              </rect>
              <text
                className="bar-value"
                x={center}
                y={barY - 8}
                textAnchor="middle"
              >
                {row.count}
              </text>
              <text
                className="category-label"
                x={center}
                y={height - 38}
                textAnchor="middle"
              >
                {row.obraName}
              </text>
              <text
                className="category-percent"
                x={center}
                y={height - 20}
                textAnchor="middle"
              >
                {formatPercent(row.cumulativePercent)}
              </text>
            </g>
          );
        })}
        <polyline className="cumulative-line" points={points} />
        {rows.map((row, index) => {
          const center = plot.left + bandWidth * (index + 0.5);
          return (
            <circle
              className="cumulative-point"
              key={`point-${row.obraId}`}
              cx={center}
              cy={yForPercent(row.cumulativePercent)}
              r="5"
            >
              <title>{`${row.obraName}: acumulado ${formatPercent(
                row.cumulativePercent
              )}`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="axis-caption">
        <span>Eixo esquerdo: quantidade de ocorrências</span>
        <span>Eixo direito: percentual acumulado</span>
      </div>
    </div>
  );
}

export default function App() {
  const [workFilter, setWorkFilter] = useState("all");
  const [supplierFilter, setSupplierFilter] = useState("all");

  const orderById = useMemo(
    () => new Map(orders.map((order) => [order.id, order])),
    []
  );
  const works = useMemo(
    () => [
      ...new Map(
        orders.map((order) => [order.obra.id, order.obra.nome])
      ).entries(),
    ],
    []
  );
  const suppliers = useMemo(
    () => [...new Set(orders.map((order) => order.fornecedor))].sort(),
    []
  );
  const filteredOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          (workFilter === "all" || order.obra.id === workFilter) &&
          (supplierFilter === "all" || order.fornecedor === supplierFilter)
      ),
    [workFilter, supplierFilter]
  );
  const filteredOrderIds = useMemo(
    () => new Set(filteredOrders.map((order) => order.id)),
    [filteredOrders]
  );
  const filteredReceipts = useMemo(
    () => receipts.filter((receipt) => filteredOrderIds.has(receipt.orderId)),
    [filteredOrderIds]
  );
  const analysis = useMemo(
    () =>
      analyzeReceipts({
        orders: filteredOrders,
        receipts: filteredReceipts,
        config,
      }),
    [filteredOrders, filteredReceipts]
  );

  const rows = filteredReceipts.map((receipt) => {
    const order = orderById.get(receipt.orderId);
    const duration = receipt.linkedAt
      ? calculateLinkageDuration(receipt).days
      : calculateOpenAge(receipt, config.cutoffAt).days;
    return {
      receipt,
      order,
      duration,
      classification: classify(receipt, analysis),
    };
  });
  const hasResults = filteredReceipts.length > 0;
  const hasPareto = analysis.paretoLateByWork.length > 0;

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">MASP · análise de recebimentos</p>
          <h1>Onde o vínculo está demorando?</h1>
          <p className="subtitle">
            Uma leitura operacional da base de recebimentos sintética, com
            pendências abertas separadas dos vínculos concluídos.
          </p>
        </div>
        <div className="simulation-badge" role="note">
          <strong>Ambiente de simulação acadêmica</strong>
          <span>Dados inteiramente fictícios</span>
        </div>
      </header>

      <section className="context-strip" aria-label="Contexto da simulação">
        <span>
          <b>Data de corte</b> {formatDate(config.cutoffAt)} · {config.cutoffAt}
        </span>
        <span>
          <b>Prazo</b> {config.linkageDeadlineDays} dias corridos
        </span>
        <span>
          <b>Datas</b> ISO 8601 em UTC (Z), sem conversão local
        </span>
      </section>

      <section className="filters" aria-labelledby="filters-title">
        <div>
          <p className="section-kicker">Recorte</p>
          <h2 id="filters-title">Explore a operação sintética</h2>
        </div>
        <label>
          Obra
          <select
            value={workFilter}
            onChange={(event) => setWorkFilter(event.target.value)}
          >
            <option value="all">Todas as obras</option>
            {works.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fornecedor
          <select
            value={supplierFilter}
            onChange={(event) => setSupplierFilter(event.target.value)}
          >
            <option value="all">Todos os fornecedores</option>
            {suppliers.map((supplier) => (
              <option key={supplier} value={supplier}>
                {supplier}
              </option>
            ))}
          </select>
        </label>
        <button
          className="clear-button"
          type="button"
          onClick={() => {
            setWorkFilter("all");
            setSupplierFilter("all");
          }}
        >
          Limpar filtros
        </button>
      </section>

      <section className="metrics-grid" aria-label="Indicadores MASP">
        <Metric
          label="Recebimentos válidos"
          value={String(analysis.completedLinkages + analysis.openReceipts)}
          detail={`${filteredReceipts.length} registros no recorte`}
        />
        <Metric
          label="Vínculos concluídos"
          value={String(analysis.completedLinkages)}
          detail={`Denominador: ${analysis.denominators.completedLinkages}`}
        />
        <Metric
          label="Concluídos fora do prazo"
          value={String(analysis.lateLinkages)}
          detail="Somente vínculos válidos"
        />
        <Metric
          label="Percentual fora do prazo"
          value={`${analysis.lateLinkagePercent.toLocaleString("pt-BR", {
            maximumFractionDigits: 1,
          })}%`}
          detail={`${analysis.lateLinkages} / ${analysis.denominators.lateLinkages} concluídos`}
        />
        <Metric
          label="Sem vínculo"
          value={String(analysis.openReceipts)}
          detail={`Denominador aberto: ${analysis.denominators.openReceipts}`}
        />
        <Metric
          label="Abertos vencidos"
          value={String(analysis.overdueOpenReceipts)}
          detail={`Idade > ${config.linkageDeadlineDays} dias`}
        />
        <Metric
          label="Mediana de vinculação"
          value={formatDays(analysis.medianLinkageDays)}
          detail="Apenas vínculos concluídos"
        />
      </section>

      <section className="two-column">
        <article className="panel pareto-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Prioridade visual</p>
              <h2>Pareto por obra</h2>
            </div>
            <span className="legend-line">Referência 80% no eixo direito</span>
          </div>
          <p className="explanation">
            Colunas mostram ocorrências de vínculos concluídos fora do prazo. A
            linha mostra o percentual acumulado; a ordenação usa frequência
            decrescente e, em empate, o ID da obra.
          </p>
          {!hasPareto ? (
            <p className="empty-state">
              Não disponível: não há vínculos concluídos fora do prazo neste
              recorte.
            </p>
          ) : (
            <ParetoChart rows={analysis.paretoLateByWork} />
          )}
          {hasPareto && (
            <div className="table-wrap">
              <table>
                <caption>
                  Pareto acessível por obra dos vínculos fora do prazo
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Obra</th>
                    <th scope="col">Ocorrências</th>
                    <th scope="col">Percentual</th>
                    <th scope="col">Acumulado</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.paretoLateByWork.map((row) => (
                    <tr key={`table-${row.obraId}`}>
                      <td>{row.obraName}</td>
                      <td>{row.count}</td>
                      <td>{formatPercent(row.percent)}</td>
                      <td>{formatPercent(row.cumulativePercent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="pareto-summary" role="status">
            {analysis.paretoLateByWork.length === 2 &&
            analysis.paretoLateByWork.every((row) => row.count === 1)
              ? "Há duas ocorrências distribuídas igualmente entre duas obras; não há concentração 80/20 nesta base."
              : !hasPareto
              ? "Sem ocorrências para descrever."
              : `Há ${analysis.lateLinkages} ocorrência(s) distribuída(s) entre ${analysis.paretoLateByWork.length} obra(s), sem inferir causas.`}
          </p>
        </article>
        <article className="panel quality-panel">
          <p className="section-kicker">Confiabilidade</p>
          <h2>Qualidade dos dados</h2>
          <div className="quality-count">
            <strong>{analysis.issues.length}</strong>
            <span>{"inconsist\u00eancias encontradas"}</span>
          </div>
          <p>
            {analysis.invalidReceipts.length} registro(s) excluído(s) dos
            cálculos por inconsistência. Registros inválidos permanecem listados
            abaixo quando presentes.
          </p>
          {analysis.issues.length === 0 ? (
            <p className="quality-ok">
              ✓ Nenhuma inconsistência na base atual.
            </p>
          ) : (
            <ul className="issue-list">
              {analysis.issues.map((issue, index) => (
                <li key={`${issue.receiptId ?? issue.type}-${index}`}>
                  {issue.receiptId ?? issue.type ?? "Entrada"}:{" "}
                  {issue.issues?.join("; ") ?? issue.message ?? issue.field}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Detalhamento</p>
            <h2>Recebimentos</h2>
          </div>
          <span className="denominator-note">
            {filteredReceipts.length} evento(s) no recorte
          </span>
        </div>
        <p className="explanation">
          Vínculos concluídos e pendências abertas são classificados
          separadamente. Entrega parcial não significa vínculo atrasado.
        </p>
        {!hasResults ? (
          <p className="empty-state">
            Nenhum recebimento encontrado para os filtros selecionados.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">
                Tabela de recebimentos sintéticos filtrados
              </caption>
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Obra</th>
                  <th scope="col">Recebimento</th>
                  <th scope="col">Vinculação</th>
                  <th scope="col">Tempo / idade</th>
                  <th scope="col">Classificação</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ receipt, order, duration, classification }) => (
                  <tr key={receipt.id}>
                    <td>
                      <strong>{order?.codigo ?? receipt.orderId}</strong>
                      <small>{receipt.id}</small>
                    </td>
                    <td>{order?.obra.nome ?? "Não disponível"}</td>
                    <td>{formatDate(receipt.receivedAt)}</td>
                    <td>{formatDate(receipt.linkedAt)}</td>
                    <td>{formatDays(duration)}</td>
                    <td>
                      <span className={`status-pill ${classification.tone}`}>
                        {classification.label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer>
        <p>
          <b>Como ler:</b> percentual fora do prazo considera apenas vínculos
          concluídos válidos. Pendências abertas ficam em denominador próprio.
          Quando não houver dados suficientes, a métrica aparece como Não
          disponível.
        </p>
        <p>
          Somente dados sintéticos · sem integração ERP · sem cálculo de custos.
        </p>
      </footer>
    </main>
  );
}
