import ExcelJS from "exceljs";

/*
|--------------------------------------------------------------------------
| Medicine Excel Import Helpers
|--------------------------------------------------------------------------
| Parses a workbook (.xlsx) into medicine import rows and produces a
| template workbook that users can fill in.
|
| Column order (1-indexed):
|   1 Medicine name         (required)
|   2 Formula name          (required, must already exist)
|   3 Company name          (required, must already exist)
|   4 Batch number          (optional)
|   5 Gauge number          (optional)
|   6 Units per pack        (required, > 0)
|   7 Purchase price        (required, >= 0)
|   8 Sale price            (optional, >= 0)
|   9 Purchase price basis  (required: "pack" or "unit", default "pack")
*/

export const IMPORT_COLUMNS = [
	{ key: "name", labelKey: "medicineName" },
	{ key: "formulaName", labelKey: "formula" },
	{ key: "companyName", labelKey: "company" },
	{ key: "batchNumber", labelKey: "batchNumber" },
	{ key: "gaugeNumber", labelKey: "gaugeNumber" },
	{ key: "unitsPerPack", labelKey: "unitsPerPack" },
	{ key: "purchasePrice", labelKey: "purchasePrice" },
	{ key: "salePrice", labelKey: "salePrice" },
	{ key: "purchasePriceBasis", labelKey: "priceBasis" },
	{ key: "barcode", labelKey: "barcode" },
];

const HEADER_ALIASES = {
	name: ["medicine name", "medicine", "name", "نام دوا", "نام دواها", "د درمل نوم", "نام"],
	formulaName: ["formula name", "formula", "فرمول", "نام فرمول", "فارمول", "د فارمول نوم"],
	companyName: ["company name", "company", "شرکت", "نام شرکت", "شرکت وټاکئ", "د شرکت نوم"],
	batchNumber: ["batch number", "batch", "batch no", "شماره بچ", "بچ", "د بچ شمېره"],
	gaugeNumber: ["gauge number", "gauge", "gauge no", "گیج نمبر", "گیج", "د ګېج شمېره"],
	unitsPerPack: ["units per pack", "units", "تعداد در هر بسته", "تعداد", "په هره بسته کې شمېر"],
	purchasePrice: ["purchase price", "buy price", "قیمت خرید", "د پېرلو بیه"],
	salePrice: ["sale price", "sell price", "selling price", "قیمت فروش", "قیمت فروش", "د پلور بیه"],
	purchasePriceBasis: ["purchase price basis", "price basis", "basis", "قیمت بر اساس", "بیه د څه له مخې ده"],
	barcode: ["barcode", "bar code", "barcode number", "ean", "upc"],
};

function normalizeHeader(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLocaleLowerCase();
}

function buildHeaderMap(headerRow, labels) {
	const map = {};
	const lookup = {};
	for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
		for (const alias of aliases) {
			lookup[normalizeHeader(alias)] = key;
		}
	}
	if (typeof labels === "function") {
		for (const column of IMPORT_COLUMNS) {
			lookup[normalizeHeader(labels(column.labelKey))] = column.key;
		}
	}

	headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
		const matchedKey = lookup[normalizeHeader(cell.value)];
		if (matchedKey && map[matchedKey] === undefined) {
			map[matchedKey] = columnNumber;
		}
	});

	return map;
}

function cellText(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") {
		if (value.text !== undefined) return String(value.text).trim();
		if (value.result !== undefined) return String(value.result).trim();
		if (Array.isArray(value.richText)) {
			return value.richText.map((part) => part.text).join("").trim();
		}
	}
	return String(value).trim();
}

function cellNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "object" && value.result !== undefined) {
		return Number(cellText(value.result).replace(/[^0-9.\-]/g, ""));
	}
	const parsed = Number(cellText(value).replace(/[^0-9.\-]/g, ""));
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBasis(value) {
	const normalized = normalizeHeader(value);
	if (["pack", "بسته", "p", "pkt"].includes(normalized)) return "pack";
	if (["unit", "واحد", "u", "pc", "pcs"].includes(normalized)) return "unit";
	return normalized;
}

/**
 * Reads an .xlsx file (File or ArrayBuffer) and returns import rows.
 * A row is marked invalid when its required fields are missing so the UI
 * can preview and report problems before sending anything to the backend.
 */
export async function parseMedicineWorkbook(source, labels) {
	const workbook = new ExcelJS.Workbook();
	const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
	await workbook.xlsx.load(buffer);

	const sheet = workbook.worksheets[0];
	if (!sheet) {
		return { rows: [], headers: {}, usedHeaderRow: false };
	}

	const headerMap = buildHeaderMap(sheet.getRow(1), labels);
	const usedHeaderRow = Object.keys(headerMap).length > 0;
	const firstDataRow = usedHeaderRow ? 2 : 1;

	const columns = usedHeaderRow
		? headerMap
		: {
			name: 1,
			formulaName: 2,
			companyName: 3,
			batchNumber: 4,
			gaugeNumber: 5,
			unitsPerPack: 6,
			purchasePrice: 7,
			salePrice: 8,
			purchasePriceBasis: 9,
			barcode: 10,
		};

	const rows = [];
	sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
		if (rowNumber < firstDataRow) return;

		const read = (key) => {
			const column = columns[key];
			return column === undefined ? "" : cellText(row.getCell(column).value);
		};

		const name = read("name");
		const formulaName = read("formulaName");
		const companyName = read("companyName");
		const batchNumber = read("batchNumber");
		const gaugeNumber = read("gaugeNumber");
		const barcode = read("barcode");
		const unitsPerPack = cellNumber(columns.unitsPerPack === undefined ? "" : row.getCell(columns.unitsPerPack).value);
		const purchasePrice = cellNumber(columns.purchasePrice === undefined ? "" : row.getCell(columns.purchasePrice).value);
		const rawSalePrice = columns.salePrice === undefined ? "" : row.getCell(columns.salePrice).value;
		const salePrice = cellNumber(rawSalePrice);
		const basis = normalizeBasis(read("purchasePriceBasis"));

		if (!name && !formulaName && !companyName) return;

		const purchasePriceBasis = basis === "unit" ? "unit" : "pack";
		const errors = [];
		if (!name) errors.push("name");
		if (!formulaName) errors.push("formulaName");
		if (!companyName) errors.push("companyName");
		if (unitsPerPack === null || unitsPerPack <= 0) errors.push("unitsPerPack");
		if (purchasePrice === null || purchasePrice < 0) errors.push("purchasePrice");

		rows.push({
			rowNumber,
			name,
			formulaName,
			companyName,
			batchNumber,
			gaugeNumber,
			barcode,
			unitsPerPack: unitsPerPack ?? 0,
			purchasePrice: purchasePrice ?? 0,
			salePrice: salePrice === null ? 0 : Math.max(salePrice, 0),
			purchasePriceBasis,
			errors,
		});
	});

	return { rows, headers: columns, usedHeaderRow };
}

/**
 * Builds a ready-to-fill template workbook with the expected headers.
 */
export async function buildMedicineTemplateBlob(labels) {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet("Medicines");

	sheet.columns = IMPORT_COLUMNS.map((column) => ({
		header: resolveColumnLabel(column, labels),
		key: column.key,
		width: Math.max(18, resolveColumnLabel(column, labels).length + 4),
	}));

	sheet.getRow(1).font = { bold: true };
	sheet.views = [{ state: "frozen", ySplit: 1 }];

	const buffer = await workbook.xlsx.writeBuffer();
	return new Blob([buffer], {
		type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	});
}

function resolveColumnLabel(column, labels) {
	const label = typeof labels === "function"
		? labels(column.labelKey)
		: labels?.[column.labelKey];
	return label || column.labelKey;
}

/** Builds an Excel file using the same columns accepted by the import flow. */
export async function buildMedicineExportBlob(medicines, labels) {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet("Medicines");
	sheet.columns = IMPORT_COLUMNS.map((column) => ({
		header: resolveColumnLabel(column, labels),
		key: column.key,
		width: Math.max(18, resolveColumnLabel(column, labels).length + 4),
	}));
	sheet.addRows(medicines.map((medicine) => ({
		name: medicine.name || "",
		formulaName: medicine.formulaName || "",
		companyName: medicine.companyName || "",
		batchNumber: medicine.batchNumber || "",
		gaugeNumber: medicine.gaugeNumber || "",
		barcode: medicine.barcode || "",
		unitsPerPack: medicine.unitsPerPack ?? "",
		purchasePrice: medicine.purchasePrice ?? "",
		salePrice: medicine.salePrice ?? "",
		purchasePriceBasis: medicine.purchasePriceBasis || "pack",
	})));
	sheet.getRow(1).font = { bold: true };
	sheet.views = [{ state: "frozen", ySplit: 1 }];
	const buffer = await workbook.xlsx.writeBuffer();
	return new Blob([buffer], {
		type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	});
}
