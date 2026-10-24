import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { saveExcelExport } from "../../sevices/database";
import ExcelJS from "exceljs";

export async function exportReport({ title, columns, rows, summaries, metadata, notes, language, textValue, t }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Spice Management";
  const sheet = workbook.addWorksheet("Report", { views: [{ rightToLeft: language !== "en", state: "frozen", ySplit: metadata.length + 3 }] });
  sheet.addRow([title]).font = { size: 16, bold: true };
  for (const [key, value] of metadata) sheet.addRow([key, value]);
  sheet.addRow([]);
  const headerRow = sheet.addRow(columns.map((column) => t(column.label)));
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF23466D" } };
  for (const row of rows) sheet.addRow(columns.map((column) => {
    const value = row[column.key];
    return ["money", "number"].includes(column.type) && value != null ? Number(value) : textValue(column, row);
  }));
  sheet.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: Math.max(headerRow.number, sheet.rowCount), column: columns.length } };
  columns.forEach((column, i) => { sheet.getColumn(i + 1).width = column.type === "text" ? 30 : 23; if (column.type === "money") sheet.getColumn(i + 1).numFmt = '#,##0.00;[Red]-#,##0.00'; });
  sheet.addRow([]);
  for (const item of summaries) sheet.addRow([t(item.label), item.value == null ? t("r.na") : item.value]);
  for (const note of notes) sheet.addRow([t(note)]);
  sheet.pageSetup = { paperSize: 9, orientation: columns.length > 7 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const buffer = await workbook.xlsx.writeBuffer();
  if (isTauri()) {
    const path = await save({ title: t("r.excel"), defaultPath: "report.xlsx", filters: [{ name: "Excel", extensions: ["xlsx"] }] });
    if (!path) return false;
    await saveExcelExport(path, Array.from(new Uint8Array(buffer)));
  } else {
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = "report.xlsx"; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return true;
}
