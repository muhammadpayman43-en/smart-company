import { FiPrinter } from "react-icons/fi";
import { useLanguage } from "../../../i18n/translation";
import "./PrintControls.css";
import {useAccess} from "../../../context/AccessContext";

export const printFormats = ["a4", "a5", "80mm", "58mm"];

function PrintControls({ format, onFormatChange, label }) {
  const { t } = useLanguage();
  const {canHere}=useAccess();
  if(!canHere("print"))return null;
  return <div className="print-controls">
    <label><span>{t("printFormat")}</span><select value={format} onChange={(event) => onFormatChange(event.target.value)}>
      <option value="a4">A4</option><option value="a5">A5</option><option value="80mm">80 mm</option><option value="58mm">58 mm</option>
    </select></label>
    <button type="button" className="products-secondary-button" onClick={() => window.print()}><FiPrinter /> {label || t("printPreview")}</button>
  </div>;
}

export default PrintControls;
