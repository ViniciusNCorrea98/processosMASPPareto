"""Generate the academic MASP workbook from synthetic JSON only."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

import xlsxwriter


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUTPUT = ROOT / "exports" / "MASP-P3-Simulacao.xlsx"
ORDER_FILES = (
    "pending-orders.json",
    "partially-delivered-orders.json",
    "fully-delivered-orders.json",
    "canceled-orders.json",
)
DAY_SECONDS = 86400


def read_json(name: str):
    with (DATA / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def instant(value: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"Timestamp without explicit UTC Z: {value!r}")
    return datetime.fromisoformat(value[:-1] + "+00:00").replace(tzinfo=None)


def iso_date(value: str) -> str:
    return value.replace("T", " ").replace(".000Z", " UTC")


def cost_value(record):
    return round(record["reworkMinutes"] / 60 * record["hourlyCostBRL"], 2)


def cost_breakdown(costs):
    return {
        "assumida_no_cenario": round(sum(cost_value(record) for record in costs if record["delayRelation"] == "assumida_no_cenario"), 2),
        "nao_atribuida": round(sum(cost_value(record) for record in costs if record["delayRelation"] == "nao_atribuida"), 2),
        "indeterminada": round(sum(cost_value(record) for record in costs if record["delayRelation"] == "indeterminada"), 2),
    }


def validate_costs(costs, receipts):
    receipt_ids = {receipt["id"] for receipt in receipts}
    seen = set()
    for record in costs:
        if not isinstance(record.get("id"), str) or record["id"] in seen:
            raise ValueError("Cost IDs must be unique strings")
        seen.add(record["id"])
        if record.get("receiptId") not in receipt_ids:
            raise ValueError(f"Cost reference does not exist: {record.get('receiptId')}")
        for field in ("reworkMinutes", "hourlyCostBRL"):
            value = record.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
                raise ValueError(f"Cost field must be a non-negative number: {field}")
        if record.get("delayRelation") not in {"assumida_no_cenario", "nao_atribuida", "indeterminada"}:
            raise ValueError("Cost delayRelation must be explicit")
    return round(sum(cost_value(record) for record in costs), 2)


def test_cost_calculation(receipts):
    sample = [
        {"id": "TEST-1", "receiptId": receipts[0]["id"], "reworkMinutes": 45, "hourlyCostBRL": 80, "delayRelation": "indeterminada"},
        {"id": "TEST-2", "receiptId": receipts[1]["id"], "reworkMinutes": 30, "hourlyCostBRL": 120, "delayRelation": "indeterminada"},
        {"id": "TEST-3", "receiptId": receipts[2]["id"], "reworkMinutes": 1, "hourlyCostBRL": 100, "delayRelation": "indeterminada"},
    ]
    if validate_costs(sample, receipts) != 121.67:
        raise AssertionError("Independent cost calculation failed")
    if validate_costs([], receipts) != 0:
        raise AssertionError("Empty cost set must total zero")
    try:
        validate_costs([{**sample[0], "receiptId": "MISSING"}], receipts)
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid receipt reference must be rejected")


def run_analysis(orders, receipts, config):
    payload = json.dumps({"orders": orders, "receipts": receipts, "config": config})
    node_code = r'''
import { analyzeReceipts } from './analysis/masp.mjs';
const input = JSON.parse(process.argv[1]);
const result = analyzeReceipts(input);
console.log(JSON.stringify({
  completedLinkages: result.completedLinkages,
  lateLinkages: result.lateLinkages,
  lateLinkagePercent: result.lateLinkagePercent,
  openReceipts: result.openReceipts,
  overdueOpenReceipts: result.overdueOpenReceipts,
  medianLinkageDays: result.medianLinkageDays,
  paretoLateByWork: result.paretoLateByWork,
  invalidReceipts: result.invalidReceipts,
  outOfScopeReceipts: result.outOfScopeReceipts,
  receiptValidation: result.receiptValidation
}));
'''
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", node_code, payload],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(completed.stdout)


def validate_xlsx(path: Path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        required = {"xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/charts/chart1.xml"}
        missing = required - names
        if missing:
            raise RuntimeError(f"Workbook parts missing: {sorted(missing)}")
        combined_chart = archive.read("xl/charts/chart1.xml").decode("utf-8")
        if "barChart" not in combined_chart or "lineChart" not in combined_chart:
            raise RuntimeError("Pareto chart is not a combined editable column/line chart")
        worksheet_parts = [name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
        if len(worksheet_parts) != 6:
            raise RuntimeError(f"Expected six worksheets, found {len(worksheet_parts)}")
        workbook_xml = archive.read("xl/workbook.xml").decode("utf-8")
        expected_sheets = ("Leia-me", "Pedidos", "Recebimentos", "Indicadores", "Pareto", "Custos")
        if any(f'name="{sheet}"' not in workbook_xml for sheet in expected_sheets):
            raise RuntimeError("Workbook sheet names or order changed unexpectedly")
        sheet_xml = {
            index: archive.read(f"xl/worksheets/sheet{index}.xml").decode("utf-8")
            for index in range(1, 7)
        }
        for index in range(1, 7):
            if "<sheetProtection" in sheet_xml[index]:
                raise RuntimeError(f"Worksheet {index} unexpectedly prevents manual editing")
            if "<pageSetup" not in sheet_xml[index]:
                raise RuntimeError(f"Worksheet {index} is missing page setup")
        for index in (2, 3):
            if "<autoFilter" not in sheet_xml[index]:
                raise RuntimeError(f"Long table worksheet {index} is missing its filter")
        for index in (2, 3, 5, 6):
            if "<pane" in sheet_xml[index]:
                raise RuntimeError(f"Worksheet {index} must not contain frozen or split panes")
            if 'autoPageBreaks="0"' not in sheet_xml[index]:
                raise RuntimeError(f"Worksheet {index} must hide page-break markers in normal view")
        required_formulas = (
            "ROUND(C5/60*D5,2)",
            "MEDIAN('Recebimentos'!$P$6:$P$12)",
            "SUMIF('Recebimentos'!$J$6:$J$12,A5,'Recebimentos'!$M$6:$M$12)",
        )
        formula_xml = "\n".join(sheet_xml.values())
        if any(formula not in formula_xml for formula in required_formulas):
            raise RuntimeError("An essential calculated formula is missing from the workbook")
        xml = "\n".join(
            archive.read(name).decode("utf-8", errors="replace")
            for name in names
            if name.endswith(".xml")
        )
        forbidden = ("archive/", "rawData.txt", "dataRaw.txt", "externalLink", "Target=http", "Target=\"http")
        found = [token for token in forbidden if token in xml]
        if found:
            raise RuntimeError(f"Unexpected source/external reference in workbook: {found}")
        formula_errors = [token for token in ("#REF!", "#VALUE!", "#DIV/0!") if token in xml]
        if formula_errors:
            raise RuntimeError(f"Formula error found in workbook XML: {formula_errors}")
        return len(names)


def hide_page_break_markers(path: Path, sheet_indexes=(2, 3, 5, 6)):
    """Disable automatic page-break markers without changing print settings."""
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".xlsx", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(temporary, "w") as target:
            for item in source.infolist():
                data = source.read(item.filename)
                for index in sheet_indexes:
                    if item.filename == f"xl/worksheets/sheet{index}.xml":
                        text = data.decode("utf-8")
                        marker = "<pageSetUpPr "
                        if marker not in text:
                            raise RuntimeError(f"Worksheet {index} has no page setup properties")
                        text = text.replace(marker, '<pageSetUpPr autoPageBreaks="0" ', 1)
                        data = text.encode("utf-8")
                target.writestr(item, data)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def pareto_interpretation(rows):
    if not rows:
        return "Não há recebimentos vinculados fora do prazo neste recorte; não há distribuição a interpretar."
    if len(rows) == 2 and all(row["count"] == 1 for row in rows):
        return "Há duas ocorrências distribuídas igualmente entre duas obras, com 50% e 100% acumulados; a base não força concentração 80/20 e não permite inferir causas."
    return f"Há {sum(row['count'] for row in rows)} ocorrência(s) distribuída(s) entre {len(rows)} obra(s); a descrição é apenas distributiva e não infere causas nem concentração 80/20."


def main():
    orders = [order for filename in ORDER_FILES for order in read_json(filename)]
    receipts = read_json("receipts.json")
    costs = read_json("rework-costs.json")
    config = read_json("analysis-config.json")
    order_by_id = {order["id"]: order for order in orders}
    test_cost_calculation(receipts)
    total_cost = validate_costs(costs, receipts)
    cost_totals = cost_breakdown(costs)
    analysis = run_analysis(orders, receipts, config)
    if analysis["invalidReceipts"]:
        raise RuntimeError("Synthetic source has invalid receipts; export stopped without repair")

    output = analysis
    validation_by_id = {item["receiptId"]: item for item in output["receiptValidation"]}
    if (output["completedLinkages"], output["lateLinkages"], output["openReceipts"], output["overdueOpenReceipts"], output["medianLinkageDays"]) != (5, 2, 2, 1, 3):
        raise RuntimeError(f"Unexpected MASP baseline: {output}")

    late_by_work = output["paretoLateByWork"]
    if [row["count"] for row in late_by_work] != [1, 1] or [row["cumulativePercent"] for row in late_by_work] != [50, 100]:
        raise RuntimeError(f"Unexpected Pareto baseline: {late_by_work}")
    if total_cost != 150 or cost_totals != {"assumida_no_cenario": 120, "nao_atribuida": 30, "indeterminada": 0}:
        raise RuntimeError(f"Unexpected cost reconciliation: {total_cost}, {cost_totals}")
    expected_work_names = {order["obra"]["nome"] for order in orders}
    if any(row["obraName"] not in expected_work_names for row in late_by_work):
        raise RuntimeError("UTF-8 regression: Pareto work name differs from the synthetic order data")

    OUTPUT.parent.mkdir(exist_ok=True)
    workbook = xlsxwriter.Workbook(str(OUTPUT))
    workbook.set_properties({
        "title": "MASP - análise acadêmica com dados sintéticos",
        "subject": "Indicadores de prazo, distribuição de ocorrências e estimativa de custos",
        "comments": "Dados sintéticos utilizados exclusivamente para análise acadêmica.",
    })
    workbook.set_calc_mode("auto")

    base = {"font_name": "Arial", "font_size": 11, "font_color": "#1F2933"}
    border = {"border": 1, "border_color": "#C9D3DC"}

    def cell_format(**options):
        return workbook.add_format({**base, **border, "valign": "top", **options})

    title = workbook.add_format({**base, "bold": True, "font_size": 18, "font_color": "#FFFFFF", "bg_color": "#17324D", "align": "left", "valign": "vcenter"})
    context = workbook.add_format({**base, "font_color": "#334E68", "bg_color": "#EAF1F6", "text_wrap": True, "valign": "vcenter"})
    section = workbook.add_format({**base, "bold": True, "font_size": 12, "font_color": "#17324D", "bg_color": "#DCEAF3", "bottom": 1, "bottom_color": "#9CB8CA", "valign": "vcenter"})
    header = cell_format(bold=True, font_color="#FFFFFF", bg_color="#245B7A", text_wrap=True, align="left", valign="vcenter")
    label = cell_format(bold=True, bg_color="#E8F0F5", text_wrap=True)
    text_even = cell_format(bg_color="#FFFFFF", text_wrap=True)
    text_odd = cell_format(bg_color="#F5F8FA", text_wrap=True)
    integer_even = cell_format(bg_color="#FFFFFF", num_format="0", align="right")
    integer_odd = cell_format(bg_color="#F5F8FA", num_format="0", align="right")
    decimal_even = cell_format(bg_color="#FFFFFF", num_format="0.00", align="right")
    decimal_odd = cell_format(bg_color="#F5F8FA", num_format="0.00", align="right")
    days_even = cell_format(bg_color="#FFFFFF", num_format='0.00 "dias"', align="right")
    days_odd = cell_format(bg_color="#F5F8FA", num_format='0.00 "dias"', align="right")
    percent_even = cell_format(bg_color="#FFFFFF", num_format="0%", align="right")
    percent_odd = cell_format(bg_color="#F5F8FA", num_format="0%", align="right")
    money_even = cell_format(bg_color="#FFFFFF", num_format='R$ #,##0.00', align="right")
    money_odd = cell_format(bg_color="#F5F8FA", num_format='R$ #,##0.00', align="right")
    date_even = cell_format(bg_color="#FFFFFF", num_format='dd/mm/yyyy hh:mm:ss "UTC"', align="right")
    date_odd = cell_format(bg_color="#F5F8FA", num_format='dd/mm/yyyy hh:mm:ss "UTC"', align="right")
    result_integer = cell_format(bold=True, font_size=12, font_color="#17324D", bg_color="#EDF4F8", num_format="0", align="right")
    result_decimal = cell_format(bold=True, font_size=12, font_color="#17324D", bg_color="#EDF4F8", num_format="0.00", align="right")
    result_percent = cell_format(bold=True, font_size=12, font_color="#17324D", bg_color="#EDF4F8", num_format="0%", align="right")
    result_money = cell_format(bold=True, font_size=12, font_color="#17324D", bg_color="#EDF4F8", num_format='R$ #,##0.00', align="right")
    note = cell_format(bg_color="#F7FAFC", text_wrap=True)
    warning_note = cell_format(bg_color="#FFF8E6", font_color="#5F4500", text_wrap=True)
    status_formats = {
        "Dentro do prazo": cell_format(bg_color="#E3F3E8", font_color="#205B35", bold=True, text_wrap=True),
        "Fora do prazo": cell_format(bg_color="#FBE5E3", font_color="#8B2C24", bold=True, text_wrap=True),
        "Aberto no prazo": cell_format(bg_color="#E8F1FA", font_color="#24577A", bold=True, text_wrap=True),
        "Aberto vencido": cell_format(bg_color="#FFF0D9", font_color="#7A4B00", bold=True, text_wrap=True),
    }

    def configure_sheet(sheet, landscape=False, zoom=90):
        sheet.hide_gridlines(2)
        sheet.set_zoom(zoom)
        sheet.set_default_row(18)
        sheet.set_paper(9)
        if landscape:
            sheet.set_landscape()
        else:
            sheet.set_portrait()
        sheet.set_margins(left=0.3, right=0.3, top=0.45, bottom=0.55)
        sheet.center_horizontally()
        sheet.set_footer('&L&A&R Página &P de &N', {"margin": 0.25})
        sheet.set_top_left_cell(0, 0)

    def write_title(sheet, last_col, heading, description):
        sheet.merge_range(0, 0, 0, last_col, heading, title)
        sheet.merge_range(1, 0, 1, last_col, description, context)
        sheet.set_row(0, 29)
        sheet.set_row(1, 34)

    # Leia-me: four concise sections with one label area and one wide explanation area.
    readme = workbook.add_worksheet("Leia-me")
    readme.set_tab_color("#17324D")
    configure_sheet(readme, landscape=False, zoom=95)
    readme.set_column("A:B", 15)
    readme.set_column("C:H", 14)
    write_title(readme, 7, "MASP — análise acadêmica", "Planilha elaborada com dados, custos e resultados sintéticos.")
    receipt_dates = [r["receivedAt"] for r in receipts]
    cutoff_row = 9
    deadline_row = 10
    readme_sections = [
        (3, "1. Finalidade e natureza sintética", [
            (4, "Finalidade", "Apresentar indicadores de prazo, distribuição de ocorrências e estimativas de custo no contexto do MASP."),
            (5, "Natureza", "Análise acadêmica baseada exclusivamente em dados fictícios, sem vínculo com uma empresa ou operação real."),
            (6, "Unidade de análise", "Cada evento de recebimento constitui uma unidade de análise e é contado uma única vez."),
        ]),
        (8, "2. Recorte, corte temporal e prazo", [
            (cutoff_row, "Data de corte (UTC)", instant(config["cutoffAt"])),
            (deadline_row, "Prazo de vinculação", config["linkageDeadlineDays"]),
            (11, "Convenção de datas", "Datas e horários são apresentados em UTC, sem conversão para o horário local."),
            (12, "Período dos recebimentos", f"{iso_date(min(receipt_dates))} a {iso_date(max(receipt_dates))}"),
            (13, "Recorte", "O conjunto analisado reúne sete recebimentos sintéticos e não representa uma população estatística."),
        ]),
        (15, "3. Método e interpretação", [
            (16, "Regra de prazo", "Vínculo concluído em até 3 dias corridos é Dentro do prazo; acima de 3 dias é Fora do prazo. Sem data de vínculo, o recebimento permanece aberto."),
            (17, "Pendências abertas", "Para concluídos, o tempo vai do recebimento ao vínculo. Para abertos, a idade vai do recebimento ao corte fixo. Aberto vencido não integra o denominador de concluídos."),
            (18, "Cálculo", "Os intervalos são calculados em dias corridos. A mediana considera somente os vínculos concluídos e válidos."),
            (19, "Interpretação", "O percentual de 40% corresponde a 2 vínculos fora do prazo entre 5 vínculos concluídos. As 2 pendências abertas são apresentadas separadamente."),
        ]),
        (21, "4. Custos e limitações", [
            (22, "Custos fictícios", "O total estimado é de R$ 150,00: R$ 120,00 associados aos atrasos por premissa, R$ 30,00 não atribuídos e R$ 0,00 indeterminados."),
            (23, "Limitações", "Os valores não comprovam causalidade, prejuízo real, multas, perdas ou ausência de documentos."),
        ]),
    ]
    for section_row, heading, entries in readme_sections:
        readme.merge_range(section_row, 0, section_row, 7, heading, section)
        readme.set_row(section_row, 23)
        for row, key, value in entries:
            readme.merge_range(row, 0, row, 1, key, label)
            readme.merge_range(row, 2, row, 7, "", note)
            if isinstance(value, datetime):
                readme.write_datetime(row, 2, value, date_even)
            elif key == "Prazo de vinculação":
                readme.write_number(row, 2, value, integer_even)
            else:
                readme.write(row, 2, value, note)
            readme.set_row(row, 34 if row not in (18, 22, 23) else 47)
    readme.print_area(0, 0, 23, 7)
    readme.fit_to_pages(1, 0)
    readme.set_selection("A1")

    # Pedidos: reading fields first, raw codes and JSON details in an outlined technical block.
    orders_sheet = workbook.add_worksheet("Pedidos")
    orders_sheet.set_tab_color("#245B7A")
    configure_sheet(orders_sheet, landscape=True)
    write_title(orders_sheet, 13, "Pedidos — base sintética", "A tabela reúne 12 pedidos. Situação operacional e aprovação são dimensões distintas. Campos vazios indicam apenas ausência de valor na base sintética.")
    order_header_row = 4
    order_data_start = 5
    order_headers = ["Código do pedido", "Fornecedor", "Obra", "Emissão (UTC)", "Valor do pedido (R$)", "Situação operacional", "Aprovação", "ID técnico do pedido", "Código da situação", "Código da aprovação", "Autorizado no cenário", "ID técnico da obra", "Itens (JSON)", "NFe (JSON sintético)"]
    orders_sheet.write_row(order_header_row, 0, order_headers, header)
    operational_labels = {"PENDING": "Pendente", "PARTIALLY_DELIVERED": "Parcialmente entregue", "FULLY_DELIVERED": "Totalmente entregue", "CANCELED": "Cancelado"}
    approval_labels = {"APPROVED": "Aprovado"}
    for offset, order in enumerate(orders):
        row = order_data_start + offset
        odd = offset % 2 == 1
        tf = text_odd if odd else text_even
        orders_sheet.write(row, 0, order["codigo"], tf)
        orders_sheet.write(row, 1, order["fornecedor"], tf)
        orders_sheet.write(row, 2, order["obra"]["nome"], tf)
        orders_sheet.write_datetime(row, 3, instant(order["dataEmissao"]), date_odd if odd else date_even)
        orders_sheet.write_number(row, 4, order["valorTotal"], money_odd if odd else money_even)
        orders_sheet.write(row, 5, operational_labels[order["status"]], tf)
        if order["statusApproval"]:
            orders_sheet.write(row, 6, approval_labels.get(order["statusApproval"], order["statusApproval"]), tf)
        else:
            orders_sheet.write_blank(row, 6, None, tf)
        technical = [order["id"], order["status"], order["statusApproval"] or None, order["siengeAuthorized"], order["obra"]["id"], json.dumps(order["itens"], ensure_ascii=False), None if order["nfe"] is None else json.dumps(order["nfe"], ensure_ascii=False)]
        for col, value in enumerate(technical, 7):
            if value is None:
                orders_sheet.write_blank(row, col, None, tf)
            else:
                orders_sheet.write(row, col, value, tf)
        orders_sheet.set_row(row, 32)
    order_end = order_data_start + len(orders) - 1
    orders_sheet.set_column("A:A", 18); orders_sheet.set_column("B:B", 24); orders_sheet.set_column("C:C", 24)
    orders_sheet.set_column("D:D", 23); orders_sheet.set_column("E:E", 20); orders_sheet.set_column("F:G", 22)
    orders_sheet.set_column("H:N", 22, None, {"level": 1, "hidden": True})
    orders_sheet.set_column("O:O", 2, None, {"collapsed": True})
    orders_sheet.set_row(order_header_row, 38)
    orders_sheet.autofilter(order_header_row, 0, order_end, len(order_headers) - 1)
    orders_sheet.repeat_rows(order_header_row, order_header_row)
    # A impressão privilegia a leitura acadêmica; o detalhamento técnico continua
    # disponível e filtrável na planilha pelo agrupamento à direita.
    orders_sheet.print_area(0, 0, order_end, 6)
    orders_sheet.fit_to_pages(1, 1)
    orders_sheet.set_selection("A1")

    # Recebimentos: primary analytical view followed by grouped calculation columns.
    receipt_sheet = workbook.add_worksheet("Recebimentos")
    receipt_sheet.set_tab_color("#2D6A8A")
    configure_sheet(receipt_sheet, landscape=True)
    cutoff_date = instant(config["cutoffAt"]).strftime("%d/%m/%Y")
    write_title(receipt_sheet, 17, "Recebimentos — eventos analisados", f"Dados sintéticos: nos concluídos, o tempo termina no vínculo; nos abertos, a idade é calculada até {cutoff_date}, data de corte.")
    receipt_header_row = 4
    receipt_data_start = 5
    receipt_headers = ["Recebimento", "Código do pedido", "Obra", "Fornecedor", "Recebimento (UTC)", "Vínculo (UTC)", "Tempo / idade (dias)", "Classificação", "ID técnico do pedido", "ID técnico da obra", "Válido", "Vínculo concluído", "Fora do prazo", "Sem vínculo", "Aberto vencido", "Tempo elegível", "Situação de validação", "Motivo de exclusão"]
    receipt_sheet.write_row(receipt_header_row, 0, receipt_headers, header)
    for offset, receipt in enumerate(receipts):
        row = receipt_data_start + offset
        excel_row = row + 1
        odd = offset % 2 == 1
        tf = text_odd if odd else text_even
        df = decimal_odd if odd else decimal_even
        days_format = days_odd if odd else days_even
        inf = integer_odd if odd else integer_even
        order = order_by_id[receipt["orderId"]]
        receipt_sheet.write(row, 0, receipt["id"], tf)
        receipt_sheet.write(row, 1, order["codigo"], tf)
        receipt_sheet.write(row, 2, order["obra"]["nome"], tf)
        receipt_sheet.write(row, 3, order["fornecedor"], tf)
        receipt_sheet.write_datetime(row, 4, instant(receipt["receivedAt"]), date_odd if odd else date_even)
        if receipt["linkedAt"] is None:
            receipt_sheet.write_blank(row, 5, None, date_odd if odd else date_even)
        else:
            receipt_sheet.write_datetime(row, 5, instant(receipt["linkedAt"]), date_odd if odd else date_even)
        duration = None if receipt["linkedAt"] is None else (instant(receipt["linkedAt"]) - instant(receipt["receivedAt"])).total_seconds() / DAY_SECONDS
        age = (instant(config["cutoffAt"]) - instant(receipt["receivedAt"])).total_seconds() / DAY_SECONDS if receipt["linkedAt"] is None else duration
        receipt_sheet.write_formula(row, 6, f'=IF(E{excel_row}="","",IF(F{excel_row}="",\'Leia-me\'!$C${cutoff_row + 1}-E{excel_row},F{excel_row}-E{excel_row}))', days_format, age)
        classification = ("Aberto vencido" if age > config["linkageDeadlineDays"] else "Aberto no prazo") if receipt["linkedAt"] is None else ("Fora do prazo" if duration > config["linkageDeadlineDays"] else "Dentro do prazo")
        receipt_sheet.write_formula(row, 7, f'=IF(F{excel_row}="",IF(G{excel_row}>\'Leia-me\'!$C${deadline_row + 1},"Aberto vencido","Aberto no prazo"),IF(G{excel_row}>\'Leia-me\'!$C${deadline_row + 1},"Fora do prazo","Dentro do prazo"))', status_formats[classification], classification)
        receipt_sheet.write(row, 8, receipt["orderId"], tf)
        receipt_sheet.write(row, 9, order["obra"]["id"], tf)
        validation = validation_by_id[receipt["id"]]
        exclusion_reason = "; ".join(validation["issues"]) if validation["issues"] else ""
        formulas = [
            (10, f'=--(Q{excel_row}="valid")', 1 if validation["validationStatus"] == "valid" else 0),
            (11, f'=--AND(K{excel_row}=1,F{excel_row}<>"")', 1 if receipt["linkedAt"] else 0),
            (12, f'=--AND(K{excel_row}=1,L{excel_row}=1,G{excel_row}>\'Leia-me\'!$C${deadline_row + 1})', 1 if duration is not None and duration > config["linkageDeadlineDays"] else 0),
            (13, f'=--AND(K{excel_row}=1,F{excel_row}="")', 1 if receipt["linkedAt"] is None else 0),
            (14, f'=--AND(N{excel_row}=1,G{excel_row}>\'Leia-me\'!$C${deadline_row + 1})', 1 if receipt["linkedAt"] is None and age > config["linkageDeadlineDays"] else 0),
            (15, f'=IF(L{excel_row}=1,G{excel_row},"")', duration if receipt["linkedAt"] else ""),
        ]
        for col, formula, cached in formulas:
            receipt_sheet.write_formula(row, col, formula, df if col == 15 else inf, cached)
        receipt_sheet.write(row, 16, validation["validationStatus"], tf)
        receipt_sheet.write(row, 17, exclusion_reason, tf)
        receipt_sheet.set_row(row, 32)
    receipt_end = receipt_data_start + len(receipts) - 1
    receipt_sheet.set_column("A:A", 17); receipt_sheet.set_column("B:B", 18); receipt_sheet.set_column("C:C", 23); receipt_sheet.set_column("D:D", 25)
    receipt_sheet.set_column("E:F", 14); receipt_sheet.set_column("G:G", 18); receipt_sheet.set_column("H:H", 19)
    receipt_sheet.set_column("I:R", 20, None, {"level": 1, "hidden": True})
    receipt_sheet.set_column("S:S", 2, None, {"collapsed": True})
    receipt_sheet.set_row(receipt_header_row, 38)
    receipt_sheet.autofilter(receipt_header_row, 0, receipt_end, len(receipt_headers) - 1)
    receipt_sheet.repeat_rows(receipt_header_row, receipt_header_row)
    receipt_sheet.print_area(0, 0, receipt_end, 7)
    receipt_sheet.fit_to_pages(1, 1)
    receipt_sheet.set_selection("A1")

    # Indicadores: completed linkages and open receipts are deliberately separate.
    indicator_sheet = workbook.add_worksheet("Indicadores")
    indicator_sheet.set_tab_color("#4C7A91")
    configure_sheet(indicator_sheet, landscape=False, zoom=95)
    indicator_sheet.set_column("A:A", 38); indicator_sheet.set_column("B:B", 18); indicator_sheet.set_column("C:F", 17)
    write_title(indicator_sheet, 5, "Indicadores do MASP", "Síntese dos resultados calculados a partir dos sete eventos válidos.")
    indicator_sheet.merge_range(3, 0, 3, 5, "Vínculos concluídos", section)
    indicator_sheet.write(4, 0, "Indicador", header)
    indicator_sheet.write(4, 1, "Resultado", header)
    indicator_sheet.merge_range(4, 2, 4, 5, "Como interpretar", header)
    completed_rows = [
        (5, "Recebimentos válidos", f"=SUM('Recebimentos'!$K${receipt_data_start + 1}:$K${receipt_end + 1})", output["completedLinkages"] + output["openReceipts"], "Todos os eventos válidos; inválidos e fora do recorte seriam excluídos.", result_integer),
        (6, "Vínculos concluídos", f"=SUM('Recebimentos'!$L${receipt_data_start + 1}:$L${receipt_end + 1})", output["completedLinkages"], "Somente vínculos concluídos válidos.", result_integer),
        (7, "Concluídos fora do prazo", f"=SUM('Recebimentos'!$M${receipt_data_start + 1}:$M${receipt_end + 1})", output["lateLinkages"], "Concluídos com tempo superior a 3 dias corridos.", result_integer),
        (8, "Percentual fora do prazo", "=IF(B7=0,0,B8/B7)", output["lateLinkagePercent"] / 100, "2 vínculos fora do prazo ÷ 5 vínculos concluídos = 40%.", result_percent),
        (9, "Mediana do tempo de vinculação (dias)", f"=IFERROR(MEDIAN('Recebimentos'!$P${receipt_data_start + 1}:$P${receipt_end + 1}),\"\")", output["medianLinkageDays"], "Mediana calculada somente entre vínculos concluídos válidos.", result_decimal),
    ]
    for row, name, formula, cached, explanation, result_format in completed_rows:
        indicator_sheet.write(row, 0, name, label)
        indicator_sheet.write_formula(row, 1, formula, result_format, cached)
        indicator_sheet.merge_range(row, 2, row, 5, explanation, text_even if row % 2 else text_odd)
        indicator_sheet.set_row(row, 34)
    indicator_sheet.merge_range(11, 0, 11, 5, "Pendências abertas — não integram o denominador dos concluídos", section)
    indicator_sheet.write(12, 0, "Indicador", header)
    indicator_sheet.write(12, 1, "Resultado", header)
    indicator_sheet.merge_range(12, 2, 12, 5, "Como interpretar", header)
    open_rows = [
        (13, "Recebimentos sem vínculo", f"=SUM('Recebimentos'!$N${receipt_data_start + 1}:$N${receipt_end + 1})", output["openReceipts"], "Pendências abertas na data de corte; apresentadas separadamente.", result_integer),
        (14, "Abertos vencidos", f"=SUM('Recebimentos'!$O${receipt_data_start + 1}:$O${receipt_end + 1})", output["overdueOpenReceipts"], "Abertos cuja idade no corte é superior a 3 dias.", result_integer),
    ]
    for row, name, formula, cached, explanation, result_format in open_rows:
        indicator_sheet.write(row, 0, name, label)
        indicator_sheet.write_formula(row, 1, formula, result_format, cached)
        indicator_sheet.merge_range(row, 2, row, 5, explanation, text_even if row % 2 else text_odd)
        indicator_sheet.set_row(row, 34)
    indicator_sheet.merge_range(16, 0, 16, 5, "Observação", section)
    indicator_sheet.merge_range(17, 0, 18, 5, "Os dados são sintéticos. O percentual de 40% corresponde a dois vínculos fora do prazo entre cinco concluídos. As duas pendências abertas são apresentadas separadamente.", warning_note)
    indicator_sheet.set_row(17, 34); indicator_sheet.set_row(18, 34)
    indicator_sheet.freeze_panes(5, 0)
    indicator_sheet.repeat_rows(4, 4)
    indicator_sheet.print_area(0, 0, 18, 5)
    indicator_sheet.fit_to_pages(1, 0)

    # Pareto: support table, native editable chart and wide interpretation blocks in one compact width.
    pareto_sheet = workbook.add_worksheet("Pareto")
    pareto_sheet.set_tab_color("#6B8190")
    configure_sheet(pareto_sheet, landscape=True, zoom=95)
    pareto_sheet.set_column("A:A", 18); pareto_sheet.set_column("B:B", 31); pareto_sheet.set_column("C:C", 15)
    pareto_sheet.set_column("D:F", 17)
    write_title(pareto_sheet, 5, "Pareto — vínculos concluídos fora do prazo", "Dados sintéticos: ocorrências por obra, percentual acumulado e referência de 80%.")
    pareto_header_row = 3
    pareto_data_start = 4
    pareto_sheet.write_row(pareto_header_row, 0, ["ID técnico da obra", "Obra", "Ocorrências", "% do total", "% acumulado", "Referência 80%"], header)
    pareto_end = pareto_data_start + len(late_by_work) - 1
    for offset, item in enumerate(late_by_work):
        row = pareto_data_start + offset
        excel_row = row + 1
        odd = offset % 2 == 1
        tf = text_odd if odd else text_even
        inf = integer_odd if odd else integer_even
        pf = percent_odd if odd else percent_even
        pareto_sheet.write(row, 0, item["obraId"], tf)
        pareto_sheet.write(row, 1, item["obraName"], tf)
        pareto_sheet.write_formula(row, 2, f'=SUMIF(\'Recebimentos\'!$J${receipt_data_start + 1}:$J${receipt_end + 1},A{excel_row},\'Recebimentos\'!$M${receipt_data_start + 1}:$M${receipt_end + 1})', inf, item["count"])
        pareto_sheet.write_formula(row, 3, f'=IFERROR(C{excel_row}/SUM($C${pareto_data_start + 1}:$C${pareto_end + 1}),0)', pf, item["percent"] / 100)
        pareto_sheet.write_formula(row, 4, f'=SUM($D${pareto_data_start + 1}:D{excel_row})', pf, item["cumulativePercent"] / 100)
        pareto_sheet.write_formula(row, 5, "=80%", pf, 0.8)
        pareto_sheet.set_row(row, 28)
    pareto_sheet.set_row(pareto_header_row, 35)
    pareto_sheet.autofilter(pareto_header_row, 0, pareto_end, 5)
    column_chart = workbook.add_chart({"type": "column"})
    column_chart.add_series({"name": f"=Pareto!$C${pareto_header_row + 1}", "categories": f"=Pareto!$B${pareto_data_start + 1}:$B${pareto_end + 1}", "values": f"=Pareto!$C${pareto_data_start + 1}:$C${pareto_end + 1}", "fill": {"color": "#2D6A8A"}, "border": {"color": "#17324D"}})
    column_chart.set_y_axis({"name": "Ocorrências", "min": 0, "major_unit": 1, "num_format": "0", "major_gridlines": {"visible": True, "line": {"color": "#D7E0E7"}}})
    line_chart = workbook.add_chart({"type": "line"})
    line_chart.add_series({"name": f"=Pareto!$E${pareto_header_row + 1}", "categories": f"=Pareto!$B${pareto_data_start + 1}:$B${pareto_end + 1}", "values": f"=Pareto!$E${pareto_data_start + 1}:$E${pareto_end + 1}", "y2_axis": True, "line": {"color": "#D05A3B", "width": 2.25}, "marker": {"type": "circle", "size": 6, "border": {"color": "#D05A3B"}, "fill": {"color": "#FFFFFF"}}})
    line_chart.add_series({"name": f"=Pareto!$F${pareto_header_row + 1}", "categories": f"=Pareto!$B${pareto_data_start + 1}:$B${pareto_end + 1}", "values": f"=Pareto!$F${pareto_data_start + 1}:$F${pareto_end + 1}", "y2_axis": True, "line": {"color": "#6B7280", "dash_type": "dash"}})
    line_chart.set_y2_axis({"name": "Percentual acumulado", "min": 0, "max": 1, "major_unit": 0.2, "num_format": "0%"})
    column_chart.combine(line_chart)
    column_chart.set_title({"name": "Distribuição dos vínculos fora do prazo"})
    column_chart.set_x_axis({"name": "Obra", "label_position": "low"})
    column_chart.set_legend({"position": "bottom"})
    column_chart.set_chartarea({"border": {"color": "#C9D3DC"}, "fill": {"color": "#FFFFFF"}})
    chart_row = pareto_end + 2
    pareto_sheet.insert_chart(chart_row, 0, column_chart, {"x_scale": 0.98, "y_scale": 0.86})
    pareto_note_row = chart_row + 17
    pareto_sheet.merge_range(pareto_note_row, 0, pareto_note_row, 5, "Critério de análise", section)
    pareto_sheet.merge_range(pareto_note_row + 1, 0, pareto_note_row + 2, 5, "Foram considerados recebimentos válidos e vinculados fora do prazo. As obras estão ordenadas pelo número de ocorrências e, em caso de empate, pelo código da obra. Cada recebimento é contado uma vez.", note)
    pareto_sheet.merge_range(pareto_note_row + 4, 0, pareto_note_row + 4, 5, "Interpretação dos resultados", section)
    pareto_sheet.merge_range(pareto_note_row + 5, 0, pareto_note_row + 6, 5, pareto_interpretation(late_by_work), warning_note)
    pareto_sheet.set_row(pareto_note_row, 23)
    pareto_sheet.set_row(pareto_note_row + 1, 29); pareto_sheet.set_row(pareto_note_row + 2, 29)
    pareto_sheet.set_row(pareto_note_row + 4, 23)
    pareto_sheet.set_row(pareto_note_row + 5, 29); pareto_sheet.set_row(pareto_note_row + 6, 29)
    pareto_sheet.print_area(0, 0, pareto_note_row + 6, 5)
    pareto_sheet.fit_to_pages(1, 1)
    pareto_sheet.set_selection("A1")

    # Custos: readable activity table, reconciled totals and wide premise/limitation blocks.
    costs_sheet = workbook.add_worksheet("Custos")
    costs_sheet.set_tab_color("#7B8790")
    configure_sheet(costs_sheet, landscape=True)
    costs_sheet.set_column("A:A", 36); costs_sheet.set_column("B:B", 18); costs_sheet.set_column("C:C", 12)
    costs_sheet.set_column("D:E", 19); costs_sheet.set_column("F:F", 26); costs_sheet.set_column("G:G", 44)
    costs_sheet.set_column("H:I", 22, None, {"level": 1, "hidden": True})
    costs_sheet.set_column("J:J", 2, None, {"collapsed": True})
    write_title(costs_sheet, 8, "Estimativa de custos das atividades adicionais", "Valores fictícios utilizados para análise acadêmica.")
    cost_header_row = 3
    cost_data_start = 4
    cost_headers = ["Atividade adicional", "Recebimento", "Minutos", "Custo-hora (R$)", "Custo simulado (R$)", "Relação com o atraso", "Justificativa da premissa", "ID técnico do custo", "Código técnico da relação"]
    costs_sheet.write_row(cost_header_row, 0, cost_headers, header)
    relation_labels = {"assumida_no_cenario": "Associado por premissa simulada", "nao_atribuida": "Não atribuído ao atraso", "indeterminada": "Indeterminado"}
    concise_justifications = {
        "SYN-COST-0001": "Estimativa do tempo dedicado à busca e à conferência adicional de documentos.",
        "SYN-COST-0002": "Estimativa do tempo dedicado ao reenvio da documentação.",
        "SYN-COST-0003": "Atividade registrada em recebimento dentro do prazo; custo não atribuído ao atraso.",
    }
    for offset, record in enumerate(costs):
        row = cost_data_start + offset
        excel_row = row + 1
        odd = offset % 2 == 1
        tf = text_odd if odd else text_even
        costs_sheet.write(row, 0, record["description"], tf)
        costs_sheet.write(row, 1, record["receiptId"], tf)
        costs_sheet.write_number(row, 2, record["reworkMinutes"], integer_odd if odd else integer_even)
        costs_sheet.write_number(row, 3, record["hourlyCostBRL"], money_odd if odd else money_even)
        costs_sheet.write_formula(row, 4, f'=ROUND(C{excel_row}/60*D{excel_row},2)', money_odd if odd else money_even, cost_value(record))
        costs_sheet.write(row, 5, relation_labels[record["delayRelation"]], tf)
        costs_sheet.write(row, 6, concise_justifications.get(record["id"], record["assumptionJustification"]), tf)
        costs_sheet.write(row, 7, record["id"], tf)
        costs_sheet.write(row, 8, record["delayRelation"], tf)
        costs_sheet.set_row(row, 44)
    cost_end = cost_data_start + len(costs) - 1
    costs_sheet.set_row(cost_header_row, 40)
    costs_sheet.autofilter(cost_header_row, 0, cost_end, len(cost_headers) - 1)
    total_section_row = cost_end + 2
    costs_sheet.merge_range(total_section_row, 0, total_section_row, 6, "Resumo dos custos", section)
    total_items = [
        ("Total registrado", f'=ROUND(SUM(E{cost_data_start + 1}:E{cost_end + 1}),2)', total_cost),
        ("Associado por premissa simulada", f'=ROUND(SUMIF(I{cost_data_start + 1}:I{cost_end + 1},"assumida_no_cenario",E{cost_data_start + 1}:E{cost_end + 1}),2)', cost_totals["assumida_no_cenario"]),
        ("Não atribuído ao atraso", f'=ROUND(SUMIF(I{cost_data_start + 1}:I{cost_end + 1},"nao_atribuida",E{cost_data_start + 1}:E{cost_end + 1}),2)', cost_totals["nao_atribuida"]),
        ("Indeterminado", f'=ROUND(SUMIF(I{cost_data_start + 1}:I{cost_end + 1},"indeterminada",E{cost_data_start + 1}:E{cost_end + 1}),2)', cost_totals["indeterminada"]),
    ]
    for index, (name, formula, cached) in enumerate(total_items, total_section_row + 1):
        costs_sheet.merge_range(index, 0, index, 3, name, label)
        costs_sheet.write_formula(index, 4, formula, result_money, cached)
        costs_sheet.set_row(index, 27)
    method_row = total_section_row + 6
    costs_sheet.merge_range(method_row, 0, method_row, 6, "Método de cálculo", section)
    costs_sheet.merge_range(method_row + 1, 0, method_row + 2, 6, "O custo de cada atividade corresponde ao tempo empregado, em minutos, dividido por 60 e multiplicado pelo custo por hora. Os valores são arredondados para duas casas decimais por atividade antes da soma.", note)
    costs_sheet.set_row(method_row + 1, 25)
    costs_sheet.set_row(method_row + 2, 25)
    limitation_row = method_row + 4
    costs_sheet.merge_range(limitation_row, 0, limitation_row, 6, "Limitações da análise", section)
    costs_sheet.merge_range(limitation_row + 1, 0, limitation_row + 2, 6, "Tempos e valores são fictícios. A associação de R$ 120,00 aos atrasos foi estabelecida como premissa do estudo e não demonstra causalidade ou prejuízo real. Os R$ 30,00 restantes não foram atribuídos ao atraso.", warning_note)
    costs_sheet.set_row(limitation_row + 1, 25)
    costs_sheet.set_row(limitation_row + 2, 25)
    costs_sheet.repeat_rows(cost_header_row, cost_header_row)
    costs_sheet.print_area(0, 0, limitation_row + 2, 6)
    costs_sheet.fit_to_pages(1, 0)

    readme.activate()
    try:
        workbook.close()
        hide_page_break_markers(OUTPUT, sheet_indexes=(2, 3, 5, 6))
    except PermissionError as exc:
        raise RuntimeError(f"Não foi possível substituir {OUTPUT}. Feche o arquivo no LibreOffice Calc e gere novamente.") from exc
    parts = validate_xlsx(OUTPUT)
    with zipfile.ZipFile(OUTPUT) as archive:
        shared_strings = archive.read("xl/sharedStrings.xml").decode("utf-8")
        if "Acad\u00eamica" not in shared_strings or "Acad\u00c3\u00aamica" in shared_strings:
            raise RuntimeError("UTF-8 regression: expected synthetic work name is absent from XLSX cells")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"file": str(OUTPUT), "orders": len(orders), "receipts": len(receipts), "costRecords": len(costs), "registeredCostBRL": total_cost, "analysis": output, "xlsxParts": parts}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
