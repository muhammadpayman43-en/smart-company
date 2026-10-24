import { useEffect, useRef, useState } from "react";
import { FiPlus, FiSearch, FiX, FiUpload, FiDownload, FiCheckCircle, FiAlertTriangle, FiFileText } from "react-icons/fi";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { useLanguage } from "../../i18n/translation";
import {
	createMedicine,
	createMedicineFormula,
	createPharmaceuticalCompany,
	importMedicines,
	listMedicineFormulas,
	listMedicines,
	listPharmaceuticalCompanies,
} from "../../sevices/database";
import { buildMedicineTemplateBlob, parseMedicineWorkbook } from "../../utils/medicineExcel";
import "./Products.css";

const MAX_IMPORT_ROWS = 10000;

const emptyMedicine = {
	name: "",
	formulaId: "",
	companyId: "",
	batchNumber: "",
	gaugeNumber: "",
	unitsPerPack: "",
	purchasePrice: "",
	salePrice: "",
	purchasePriceBasis: "pack",
};

const emptyFormula = { name: "", indication: "", sideEffects: "" };
const emptyCompany = { name: "", country: "", address: "", email: "", phone: "" };

function Products({ database }) {
	const { t } = useLanguage();
	const [medicines, setMedicines] = useState([]);
	const [formulas, setFormulas] = useState([]);
	const [companies, setCompanies] = useState([]);
	const [search, setSearch] = useState("");
	const [companyFilter, setCompanyFilter] = useState("all");
	const [activeDialog, setActiveDialog] = useState(null);
	const [medicineForm, setMedicineForm] = useState(emptyMedicine);
	const [formulaForm, setFormulaForm] = useState(emptyFormula);
	const [companyForm, setCompanyForm] = useState(emptyCompany);
	const [medicineDialogError, setMedicineDialogError] = useState("");
	const [lookupDialogError, setLookupDialogError] = useState("");
	const [pageError, setPageError] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	const [importRows, setImportRows] = useState([]);
	const [importFileName, setImportFileName] = useState("");
	const [importError, setImportError] = useState("");
	const [importSummary, setImportSummary] = useState(null);
	const [isImporting, setIsImporting] = useState(false);
	const [isReadingFile, setIsReadingFile] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const fileInputRef = useRef(null);

	const reloadData = async () => {
		const [medicineRows, formulaRows, companyRows] = await Promise.all([
			listMedicines(database.databasePath),
			listMedicineFormulas(database.databasePath),
			listPharmaceuticalCompanies(database.databasePath),
		]);
		setMedicines(medicineRows);
		setFormulas(formulaRows);
		setCompanies(companyRows);
	};

	useEffect(() => {
		let isMounted = true;
		Promise.all([
			listMedicines(database.databasePath),
			listMedicineFormulas(database.databasePath),
			listPharmaceuticalCompanies(database.databasePath),
		])
			.then(([medicineRows, formulaRows, companyRows]) => {
				if (!isMounted) return;
				setMedicines(medicineRows);
				setFormulas(formulaRows);
				setCompanies(companyRows);
			})
			.catch(() => {
				if (isMounted) setPageError("productsLoadFailed");
			})
			.finally(() => {
				if (isMounted) setIsLoading(false);
			});
		return () => { isMounted = false; };
	}, [database.databasePath]);

	const filteredMedicines = medicines.filter((medicine) => {
		const matchesSearch = [
			medicine.name,
			medicine.formulaName,
			medicine.companyName,
		].some((value) => value?.toLowerCase().includes(search.toLowerCase()));
		return matchesSearch && (companyFilter === "all" || medicine.companyId === companyFilter);
	});

	const handleAddMedicine = async (event) => {
		event.preventDefault();
		setMedicineDialogError("");
		setIsSaving(true);
		try {
			await createMedicine({
				databasePath: database.databasePath,
				...medicineForm,
				unitsPerPack: Number(medicineForm.unitsPerPack),
				purchasePrice: Number(medicineForm.purchasePrice),
				salePrice: Number(medicineForm.salePrice) || 0,
			});
			await reloadData();
			setMedicineForm(emptyMedicine);
			setActiveDialog(null);
		} catch {
			setMedicineDialogError("medicineSaveFailed");
		} finally {
			setIsSaving(false);
		}
	};

		};

	const handleFileSelect = async (file) => {
		setImportFileName(file.name);
		setImportError("");
		setImportSummary(null);
		setImportRows([]);
		setIsImporting(true);
		setIsReadingFile(true);
		try {
			const blob = await file.arrayBuffer();
			const result = await parseMedicineWorkbook(blob);
			setImportRows(result.rows);
			setImportError("");
			setImportSummary({
				total: result.rows.length,
				invalid: result.rows.filter((row) => row.errors.length > 0).length,
			});
		} catch (error) {
			setImportError(t("importFailed"));
			setImportSummary({ total: 0, invalid: 0 });
		} finally {
			setIsReadingFile(false);
			setIsImporting(false);
		}
	};

	return (import { useEffect, useRef, useState } from "react";
import { FiPlus, FiSearch, FiX, FiUpload, FiDownload, FiCheckCircle, FiAlertTriangle, FiFileText } from "react-icons/fi";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { useLanguage } from "../../i18n/translation";
import {
	createMedicine,
	createMedicineFormula,
	createPharmaceuticalCompany,
	importMedicines,
	listMedicineFormulas,
	listMedicines,
	listPharmaceuticalCompanies,
} from "../../sevices/database";
import { buildMedicineTemplateBlob, parseMedicineWorkbook } from "../../utils/medicineExcel";
import "./Products.css";

const MAX_IMPORT_ROWS = 10000;

const emptyMedicine = {
	name: "",
	formulaId: "",
	companyId: "",
	batchNumber: "",
	gaugeNumber: "",
	unitsPerPack: "",
	purchasePrice: "",
	salePrice: "",
	purchasePriceBasis: "pack",
};

const emptyFormula = { name: "", indication: "", sideEffects: "" };
const emptyCompany = { name: "", country: "", address: "", email: "", phone: "" };

function Products({ database }) {
	const { t } = useLanguage();
	const [medicines, setMedicines] = useState([]);
	const [formulas, setFormulas] = useState([]);
	const [companies, setCompanies] = useState([]);
	const [search, setSearch] = useState("");
	const [companyFilter, setCompanyFilter] = useState("all");
	const [activeDialog, setActiveDialog] = useState(null);
	const [medicineForm, setMedicineForm] = useState(emptyMedicine);
	const [formulaForm, setFormulaForm] = useState(emptyFormula);
	const [companyForm, setCompanyForm] = useState(emptyCompany);
	const [medicineDialogError, setMedicineDialogError] = useState("");
	const [lookupDialogError, setLookupDialogError] = useState("");
	const [pageError, setPageError] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	const [importRows, setImportRows] = useState([]);
	const [importFileName, setImportFileName] = useState("");
	const [importError, setImportError] = useState("");
	const [importSummary, setImportSummary] = useState(null);
	const [isImporting, setIsImporting] = useState(false);
	const [isReadingFile, setIsReadingFile] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const fileInputRef = useRef(null);

	const reloadData = async () => {
		const [medicineRows, formulaRows, companyRows] = await Promise.all([
			listMedicines(database.databasePath),
			listMedicineFormulas(database.databasePath),
			listPharmaceuticalCompanies(database.databasePath),
		]);
		setMedicines(medicineRows);
		setFormulas(formulaRows);
		setCompanies(companyRows);
	};

	useEffect(() => {
		let isMounted = true;
		Promise.all([
			listMedicines(database.databasePath),
			listMedicineFormulas(database.databasePath),
			listPharmaceuticalCompanies(database.databasePath),
		])
			.then(([medicineRows, formulaRows, companyRows]) => {
				if (!isMounted) return;
				setMedicines(medicineRows);
				setFormulas(formulaRows);
				setCompanies(companyRows);
			})
			.catch(() => {
				if (isMounted) setPageError("productsLoadFailed");
			})
			.finally(() => {
				if (isMounted) setIsLoading(false);
			});
		return () => { isMounted = false; };
	}, [database.databasePath]);

	const filteredMedicines = medicines.filter((medicine) => {
		const matchesSearch = [
			medicine.name,
			medicine.formulaName,
			medicine.companyName,
		].some((value) => value?.toLowerCase().includes(search.toLowerCase()));
		return matchesSearch && (companyFilter === "all" || medicine.companyId === companyFilter);
	});

	const handleAddMedicine = async (event) => {
		event.preventDefault();
		setMedicineDialogError("");
		setIsSaving(true);
		try {
			await createMedicine({
				databasePath: database.databasePath,
				...medicineForm,
				unitsPerPack: Number(medicineForm.unitsPerPack),
				purchasePrice: Number(medicineForm.purchasePrice),
				salePrice: Number(medicineForm.salePrice) || 0,
			});
			await reloadData();
			setMedicineForm(emptyMedicine);
			setActiveDialog(null);
		} catch {
			setMedicineDialogError("medicineSaveFailed");
		} finally {
			setIsSaving(false);
		}
	};

		};

	const handleFileSelect = async (file) => {
		setImportFileName(file.name);
		setImportError("");
		setImportSummary(null);
		setImportRows([]);
		setIsImporting(true);
		setIsReadingFile(true);
		try {
			const blob = await file.arrayBuffer();
			const result = await parseMedicineWorkbook(blob);
			setImportRows(result.rows);
			setImportError("");
			setImportSummary({
				total: result.rows.length,
				invalid: result.rows.filter((row) => row.errors.length > 0).length,
			});
		} catch (error) {
			setImportError(t("importFailed"));
			setImportSummary({ total: 0, invalid: 0 });
		} finally {
			setIsReadingFile(false);
			setIsImporting(false);
		}
	};

	return (


