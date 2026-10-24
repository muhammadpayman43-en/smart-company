import React, { useEffect, useState } from "react";
import { 
  FiUser, 
  FiBriefcase, 
  FiDatabase, 
  FiFolder, 
  FiX, 
  FiChevronRight, 
  FiChevronLeft, 
  FiCheckCircle 
} from "react-icons/fi";
import { open } from "@tauri-apps/plugin-dialog"; // یا @tauri-apps/api/dialog بر اساس نسخه Tauri
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useLanguage } from "../../i18n/translation";
import { createLocalDatabase } from "../../sevices/database";
import "./CreateDatabaseModel.css";

function CreateDatabaseModal({ isOpen, onClose, onCreateSuccess }) {
  const { t } = useLanguage();
  const [currentStep, setCurrentStep] = useState(1);

  // داده‌های فرم
  const [formData, setFormData] = useState({
    // Step 1: Admin
    firstName: "",
    lastName: "",
    adminPhone: "",
    password: "",
    confirmPassword: "",

    // Step 2: Company
    companyName: "",
    companyAddress: "",
    officePhone: "",
    secondaryPhone: "",
    companyEmail: "",

    // Step 3: Database
    databaseName: "",
    dbPath: ""
  });

  const [errors, setErrors] = useState({});
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const [runtimePlatform,setRuntimePlatform]=useState("desktop");
  const confirmMismatch = Boolean(formData.confirmPassword) && formData.password !== formData.confirmPassword;

  useEffect(()=>{if(!isOpen||!isTauri())return;invoke("get_local_storage_context").then(context=>{setRuntimePlatform(context.platform);if(context.platform==="android")setFormData(previous=>({...previous,dbPath:context.databaseDirectory}));}).catch(()=>{});},[isOpen]);

  if (!isOpen) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (name === "password" || name === "confirmPassword") {
      setErrors((previous) => ({ ...previous, password: null, confirmPassword: null, submit: null }));
    }
  };

  // انتخاب مسیر ذخیره‌سازی دیتابیس با استفاده از دیالوگ Tauri
  const handleSelectFolder = async () => {
    setErrors((previous) => ({ ...previous, dbPath: null, submit: null }));

    if (runtimePlatform === "android") return;
    if (!isTauri()) {
      setErrors((previous) => ({
        ...previous,
        dbPath: "folderPickerRequiresDesktop",
      }));
      return;
    }

    setIsSelectingFolder(true);
    try {
      const selectedFolder = await open({
        directory: true,
        multiple: false,
        title: t("selectDatabaseFolder")
      });

      const folderPath = Array.isArray(selectedFolder)
        ? selectedFolder[0]
        : selectedFolder;

      if (folderPath) {
        setFormData((prev) => ({ ...prev, dbPath: folderPath }));
        setErrors((previous) => ({ ...previous, dbPath: null }));
      }
    } catch (err) {
      console.error("Error selecting directory:", err);
      setErrors((previous) => ({
        ...previous,
        dbPath: "folderPickerFailed",
      }));
    } finally {
      setIsSelectingFolder(false);
    }
  };

  // اعتبار سنجی هر مرحله
  const validateStep = () => {
    let errs = {};
    if (currentStep === 1) {
      if (!formData.firstName.trim()) errs.firstName = "firstNameRequired";
      if (!formData.lastName.trim()) errs.lastName = "lastNameRequired";
      if (!formData.adminPhone.trim()) errs.adminPhone = "mobileNumberRequired";
      if (!formData.password) errs.password = "passwordRequired";
      else if (Array.from(formData.password).length < 4) errs.password = "passwordTooShort";
      if (formData.password !== formData.confirmPassword) {
        errs.confirmPassword = "passwordMismatch";
      }
    } else if (currentStep === 2) {
      if (!formData.companyName.trim()) errs.companyName = "companyNameRequired";
      if (!formData.officePhone.trim()) errs.officePhone = "officePhoneRequired";
    } else if (currentStep === 3) {
      if (!formData.databaseName.trim()) errs.databaseName = "databaseNameRequired";
      if (!formData.dbPath.trim()) errs.dbPath = "databasePathRequired";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleNext = () => {
    if (validateStep()) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    setCurrentStep((prev) => prev - 1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (Array.from(formData.password).length < 4 || formData.password !== formData.confirmPassword) {
      setCurrentStep(1);
      setErrors({
        ...(Array.from(formData.password).length < 4 ? { password: "passwordTooShort" } : {}),
        ...(formData.password !== formData.confirmPassword ? { confirmPassword: "passwordMismatch" } : {}),
      });
      return;
    }
    if (!validateStep()) return;

    if (!isTauri()) {
      setErrors({ submit: "databaseCreationRequiresDesktop" });
      return;
    }

    try {
      const result = await createLocalDatabase(formData);

      if (onCreateSuccess) onCreateSuccess(result);
      setFormData((previous) => ({
        ...previous,
        password: "",
        confirmPassword: "",
      }));
      onClose();
    } catch (error) {
      console.error("Could not create local database:", error);
      const message = typeof error === "string" ? error : error?.message;
      setErrors({
        submit: message === "database_already_exists"
          ? "databaseAlreadyExists"
          : message || "databaseCreationFailed",
      });
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-container">
        
        {/* هدر مودال */}
        <div className="modal-header">
          <h3>{t("createNewDatabase")}</h3>
          <button type="button" className="close-btn" onClick={onClose}>
            <FiX />
          </button>
        </div>

        {/* نشانگر مراحل (Stepper) */}
        <div className="stepper">
          <div className={`step-item ${currentStep >= 1 ? "active" : ""}`}>
            <div className="step-number"><FiUser /></div>
            <span>{t("adminDetails")}</span>
          </div>
          <div className="step-line"></div>
          <div className={`step-item ${currentStep >= 2 ? "active" : ""}`}>
            <div className="step-number"><FiBriefcase /></div>
            <span>{t("companyDetails")}</span>
          </div>
          <div className="step-line"></div>
          <div className={`step-item ${currentStep >= 3 ? "active" : ""}`}>
            <div className="step-number"><FiDatabase /></div>
            <span>{t("databaseDetails")}</span>
          </div>
        </div>

        {/* فرم محتوا */}
        <form onSubmit={handleSubmit} className="modal-body">

          {/* مرحله اول: مشخصات آدمین */}
          {currentStep === 1 && (
            <div className="step-content">
              <div className="form-row">
                <div className="form-group">
                  <label>{t("firstName")}</label>
                  <input
                    type="text"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleChange}
                  />
                  {errors.firstName && <span className="error-text">{t(errors.firstName)}</span>}
                </div>
                <div className="form-group">
                  <label>{t("lastName")}</label>
                  <input
                    type="text"
                    name="lastName"
                    value={formData.lastName}
                    onChange={handleChange}
                  />
                  {errors.lastName && <span className="error-text">{t(errors.lastName)}</span>}
                </div>
              </div>

              <div className="form-group">
                <label>{t("mobileNumber")}</label>
                <input
                  type="text"
                  name="adminPhone"
                  value={formData.adminPhone}
                  onChange={handleChange}
                />
                {errors.adminPhone && <span className="error-text">{t(errors.adminPhone)}</span>}
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>{t("password")}</label>
                  <input
                    type="password"
                    name="password"
                    value={formData.password}
                    onChange={handleChange}
                  />
                  {errors.password && <span className="error-text">{t(errors.password)}</span>}
                </div>
                <div className="form-group">
                  <label>{t("confirmPassword")}</label>
                  <input
                    type="password"
                    name="confirmPassword"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    className={confirmMismatch ? "confirm-password-mismatch" : ""}
                    aria-invalid={confirmMismatch}
                  />
                  {confirmMismatch && <span className="error-text">{t("passwordMismatch")}</span>}
                </div>
              </div>
            </div>
          )}

          {/* مرحله دوم: مشخصات کمپنی */}
          {currentStep === 2 && (
            <div className="step-content">
              <div className="form-group">
                <label>{t("companyName")}</label>
                <input
                  type="text"
                  name="companyName"
                  value={formData.companyName}
                  onChange={handleChange}
                />
                {errors.companyName && <span className="error-text">{t(errors.companyName)}</span>}
              </div>

              <div className="form-group">
                <label>{t("companyAddress")}</label>
                <input
                  type="text"
                  name="companyAddress"
                  value={formData.companyAddress}
                  onChange={handleChange}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>{t("officePhone")}</label>
                  <input
                    type="text"
                    name="officePhone"
                    value={formData.officePhone}
                    onChange={handleChange}
                  />
                  {errors.officePhone && <span className="error-text">{t(errors.officePhone)}</span>}
                </div>
                <div className="form-group">
                  <label>{t("secondaryPhone")}</label>
                  <input
                    type="text"
                    name="secondaryPhone"
                    value={formData.secondaryPhone}
                    onChange={handleChange}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>{t("email")}</label>
                <input
                  type="email"
                  name="companyEmail"
                  value={formData.companyEmail}
                  onChange={handleChange}
                />
              </div>
            </div>
          )}

          {/* مرحله سوم: مشخصات دیتابیس */}
          {currentStep === 3 && (
            <div className="step-content">
              <div className="form-group">
                <label>{t("databaseName")}</label>
                <input
                  type="text"
                  name="databaseName"
                  placeholder={t("databaseNameExample")}
                  value={formData.databaseName}
                  onChange={handleChange}
                />
                {errors.databaseName && <span className="error-text">{t(errors.databaseName)}</span>}
              </div>

              <div className="form-group">
                <label>{t("databasePath")}</label>
                <div className="path-input-group">
                  <input
                    type="text"
                    name="dbPath"
                    readOnly
                    value={formData.dbPath}
                    placeholder={t("noPathSelected")}
                  />
                  {runtimePlatform!=="android"&&<button
                    type="button"
                    className="browse-btn"
                    onClick={handleSelectFolder}
                    disabled={isSelectingFolder}
                  >
                    <FiFolder /> {t(isSelectingFolder ? "selectingFolder" : "browse")}
                  </button>}
                </div>
                {errors.dbPath && <span className="error-text" role="alert">{t(errors.dbPath)}</span>}
              </div>
            </div>
          )}

          {/* دکمه‌های کنترل مراحل */}
          <div className="modal-footer">
            {currentStep > 1 && (
              <button type="button" className="btn btn-secondary" onClick={handleBack}>
                <FiChevronRight /> {t("previous")}
              </button>
            )}

            {currentStep < 3 ? (
              <button type="button" className="btn btn-primary" onClick={handleNext}>
                {t("next")} <FiChevronLeft />
              </button>
            ) : (
              <button type="submit" className="btn btn-success">
                <FiCheckCircle /> {t("createDatabase")}
              </button>
            )}
          </div>
          {errors.submit && <p className="error-text" role="alert">{t(errors.submit)}</p>}

        </form>
      </div>
    </div>
  );
}

export default CreateDatabaseModal;
