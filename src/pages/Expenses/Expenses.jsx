import {useRemoteRefresh} from "../../hooks/useRemoteRefresh";
import {useCallback,useEffect,useMemo,useState} from "react";
import {confirm} from "@tauri-apps/plugin-dialog";
import {LuWallet,LuArrowUpRight,LuPlus,LuSearch,LuEye,LuPencil,LuTrash2,LuX,LuRefreshCw,LuReceipt,LuCalendarDays} from "react-icons/lu";
import {useLanguage} from "../../i18n/translation";
import {deleteCashDocument,getCashDocumentHistory,getCashRegister,saveCashDocument} from "../../sevices/database";
import {kabulToday} from "../Reports/reportEngine";
import {cashSourceTarget,cashSummary,expenseSummary,moneyRound} from "./expenseModel";
import "./Expenses.css";
import {useAccess} from "../../context/AccessContext";
import {useCurrency} from "../../context/CurrencyContext";

const categories=["rent","salary","electricity","transport","services","misc"];
const ledgerCategories=["SALE","CUSTOMER_RECEIPT","PURCHASE","SUPPLIER_PAYMENT","EXPENSE","WITHDRAWAL","DEPOSIT","REFUND","ADJUSTMENT"];
export default function Expenses({database,onOpenSource,initialTab="EXPENSE",onTabChange}) {
 const {t,language,direction}=useLanguage();
 const {can}=useAccess();
 const {currency:displayCurrency,fromAfn,rateAvailable}=useCurrency();
 const allowedTabs=["EXPENSE","WITHDRAWAL","register"].filter(key=>can(key==="EXPENSE"?"expenses":key==="WITHDRAWAL"?"withdrawals":"cash_register"));
 const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [tab,setTab]=useState(initialTab),[search,setSearch]=useState(""),[from,setFrom]=useState(""),[to,setTo]=useState(""),[category,setCategory]=useState(""),[flow,setFlow]=useState(""),[page,setPage]=useState(0);
 useEffect(()=>{const selected=allowedTabs.includes(initialTab)?initialTab:allowedTabs[0];setTab(selected);if(selected!==initialTab)onTabChange?.(selected);setCategory("");setFlow("");},[initialTab,allowedTabs.join(",")]);
 const [form,setForm]=useState(null),[readOnly,setReadOnly]=useState(false),[formError,setFormError]=useState(""),[history,setHistory]=useState([]),[historyLoading,setHistoryLoading]=useState(false);
 const [transaction,setTransaction]=useState(null);
 const databasePath=database.databasePath,today=kabulToday();
 const reload=useCallback(async()=>{setLoading(true);setError("");try{setData(await getCashRegister(databasePath));}catch{setError("exp.loadError");}finally{setLoading(false);}},[databasePath]);
  useRemoteRefresh(database,reload);
 useEffect(()=>{let active=true;setLoading(true);getCashRegister(databasePath).then((value)=>{if(active)setData(value);}).catch(()=>{if(active)setError("exp.loadError");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[databasePath]);
 useEffect(()=>setPage(0),[search,from,to,category,flow,tab]);
 const register=tab==="register",invalidRange=from&&to&&from>to;
 const cash=useMemo(()=>cashSummary(data?.transactions||[],from,to),[data,from,to]);
 const stats=useMemo(()=>expenseSummary(data?.documents||[],today,from,to),[data,today,from,to]);
 const rows=useMemo(()=>{
  const query=search.trim().toLocaleLowerCase();
  return (register?[...(data?.transactions||[])].reverse():(data?.documents||[]).filter((r)=>r.kind===tab)).filter((r)=>(!from||r.date.slice(0,10)>=from)&&(!to||r.date.slice(0,10)<=to)&&(!category||r.category===category)&&(!flow||r.direction===flow)&&(!query||[r.title,r.person,r.notes,r.description,r.source_id,r.id].some((v)=>v?.toLocaleLowerCase().includes(query))));
 },[data,register,tab,from,to,category,flow,search]);
 const pages=Math.max(1,Math.ceil(rows.length/25)),currentPage=Math.min(page,pages-1),visible=rows.slice(currentPage*25,currentPage*25+25);
 const number=(value)=>new Intl.NumberFormat(language==="en"?"en-US":language==="ps"?"ps-AF":"fa-AF",{maximumFractionDigits:2}).format(value);
 // A document retains its original currency; cash summaries use the user's display currency.
 const money=(value,originalCurrency)=>{
  if(originalCurrency)return <bdi>{number(value)} <small>{originalCurrency}</small></bdi>;
  const displayed=fromAfn(value);return <bdi>{rateAvailable?number(displayed):"—"} <small>{displayCurrency}</small></bdi>;
 };
 const errorKey=(reason)=>{const text=String(reason);return text.includes("cash_insufficient_balance")?"exp.insufficient":text.includes("cash_revision_conflict")?"exp.conflict":text.includes("cash_invalid_fields")?"exp.invalid":"exp.saveError";};
 const open=(kind,document=null,view=false)=>{
  setForm(document?{...document,amount:String(document.amount)}:{id:crypto.randomUUID(),kind,title:"",person:"",category:"misc",amount:"",currency:"AFN",date:today,payment_source:"cash",notes:""});
  setReadOnly(view);setFormError("");setHistory([]);
  if(view&&document){setHistoryLoading(true);getCashDocumentHistory(databasePath,document.id).then(setHistory).catch(()=>setFormError("exp.loadError")).finally(()=>setHistoryLoading(false));}
 };
 const save=async(event)=>{
  event.preventDefault();if(busy)return;setFormError("");
  if(!form.title.trim()||!form.date||!Number.isFinite(Number(form.amount))||moneyRound(Number(form.amount))<=0||(form.kind==="WITHDRAWAL"&&!form.person.trim())){setFormError("exp.invalid");return;}
  setBusy(true);try{
   const saved=await saveCashDocument({databasePath,id:form.id,expectedRevision:form.revision??null,kind:form.kind,title:form.title,person:form.person,category:form.category,amount:Number(form.amount),currency:form.currency,date:form.date,paymentSource:form.payment_source,notes:form.notes});
   // Keep the committed document if refreshing fails; retrying cannot create a second document.
   setData((current)=>({...current,documents:[saved,...(current?.documents||[]).filter((r)=>r.id!==saved.id)]}));setForm(null);await reload();
  }catch(reason){setFormError(errorKey(reason));}finally{setBusy(false);}
 };
 const remove=async(document)=>{
  if(busy)return;
  if(!await confirm(t("exp.confirmDelete"),{title:t("exp.delete"),kind:"warning"}))return;
  setBusy(true);setError("");try{await deleteCashDocument(databasePath,document.id,document.revision);await reload();}catch(reason){setError(errorKey(reason));}finally{setBusy(false);}
 };
 const documentActions=(row)=><div className="exp-row-actions">{[["view",LuEye,()=>open(row.kind,row,true)],["edit",LuPencil,()=>open(row.kind,row)],["delete",LuTrash2,()=>remove(row)]].filter(([key])=>can(row.kind==="EXPENSE"?"expenses":row.kind==="WITHDRAWAL"?"withdrawals":"cash_register",key)).map(([key,Icon,action])=><button key={key} className={`exp-icon ${key==="delete"?"danger":""}`} title={t(`exp.${key}`)} aria-label={t(`exp.${key}`)} disabled={busy} onClick={action}><Icon/></button>)}</div>;
 const cashActions=(row)=>{
  const document=row.source_type==="cash_document"?data.documents.find((d)=>d.id===row.source_id):null;
  if(document)return documentActions(document);
  const target=cashSourceTarget(row);
  return <div className="exp-row-actions">{[["view",LuEye],["edit",LuPencil],["delete",LuTrash2]].map(([key,Icon])=><button key={key} type="button" className={`exp-icon ${key==="delete"?"danger":""}`} aria-label={t(`exp.${key}`)} title={key==="view"?t("exp.view"):t(target&&onOpenSource?"exp.openOriginal":"exp.sourceUnavailable")} disabled={busy||(key!=="view"&&(!target||!onOpenSource))} onClick={()=>key==="view"?setTransaction(row):onOpenSource({...target,action:key})}><Icon/></button>)}</div>;
 };
 const editField=(key,value)=>setForm((current)=>({...current,[key]:value}));
 const rate=form?.currency==="USD"?(form.revision&&form.currency===data?.documents.find((r)=>r.id===form.id)?.currency?form.exchange_rate:data?.rate||0):1;
 const statKeys=register?["balance","inflow","outflow","opening","closing"]:["todayExpenses","monthExpenses","totalWithdrawals","periodExpenses"];
 return <section className="expenses-page" dir={direction} aria-busy={loading}>
  <header className="exp-heading"><div><span className="exp-eyebrow"><LuWallet/>{t("exp.register")}</span><h1>{t("exp.title")}</h1><p>{t("exp.subtitle")}</p></div><div className="exp-heading-actions"><button className="exp-button" onClick={reload} disabled={loading||busy} aria-label={t("exp.refresh")}><LuRefreshCw/></button><button className="exp-button exp-primary" hidden={!can(register?"cash_register":tab==="WITHDRAWAL"?"withdrawals":"expenses","create")} disabled={loading||!data} onClick={()=>open(register?"DEPOSIT":tab)}><LuPlus/>{t(register?"exp.newDeposit":tab==="EXPENSE"?"exp.newExpense":"exp.newWithdrawal")}</button></div></header>
  <nav className="exp-tabs" aria-label={t("exp.title")}>{allowedTabs.map((key)=><button key={key} className={tab===key?"active":""} aria-current={tab===key?"page":undefined} onClick={()=>{setTab(key);setCategory("");setFlow("");onTabChange?.(key);}}>{key==="register"?<LuWallet/>:key==="EXPENSE"?<LuReceipt/>:<LuArrowUpRight/>}{t(`exp.${key}`)}</button>)}</nav>
  {error&&<div className="exp-alert" role="alert">{t(error)}</div>}
  <div className={`exp-stats ${register?"exp-cash-stats":""}`}>{statKeys.map((key,i)=><article className={`exp-stat exp-tone-${i%4}`} key={key}><span>{t(`exp.${key}`)}{i===0?<LuWallet/>:i===1?<LuCalendarDays/>:i===2?<LuArrowUpRight/>:<LuReceipt/>}</span><strong>{loading&&!data?"…":invalidRange&&["periodExpenses","opening","closing"].includes(key)?"—":money((register?cash:stats)[key])}</strong></article>)}</div>
  <p className="exp-info">{t("exp.basis")}</p>
  {register&&<p className="exp-note">{t("exp.cashNote")}</p>}{tab==="WITHDRAWAL"&&<p className="exp-note">{t("exp.withdrawalNote")}</p>}
  <section className="exp-panel">
   <div className="exp-filters"><label className="exp-search"><span>{t("search")}</span><div><LuSearch/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder={t("exp.search")}/></div></label><label><span>{t("exp.from")}</span><input type="date" value={from} onChange={(e)=>setFrom(e.target.value)}/></label><label><span>{t("exp.to")}</span><input type="date" value={to} onChange={(e)=>setTo(e.target.value)}/></label>{tab!=="WITHDRAWAL"&&<label><span>{t("exp.category")}</span><select value={category} onChange={(e)=>setCategory(e.target.value)}><option value="">{t("exp.all")}</option>{(register?ledgerCategories:categories).map((key)=><option key={key} value={key}>{t(`exp.${key}`)}</option>)}</select></label>}{register&&<label><span>{t("exp.direction")}</span><select value={flow} onChange={(e)=>setFlow(e.target.value)}><option value="">{t("exp.all")}</option><option value="IN">{t("exp.IN")}</option><option value="OUT">{t("exp.OUT")}</option></select></label>}</div>
   {invalidRange?<div className="exp-empty" role="alert">{t("exp.periodError")}</div>:loading&&!data?<div className="exp-empty" role="status">{t("exp.loading")}</div>:<div className="exp-table-scroll"><table className="exp-table"><thead><tr><th>{t("exp.date")}</th><th>{t(register?"exp.reference":"exp.titleField")}</th><th>{t("exp.category")}</th>{tab==="WITHDRAWAL"&&<th>{t("exp.person")}</th>}<th>{t("exp.amount")}</th><th>{t(register?"exp.direction":"exp.source")}</th><th>{t("exp.basisAmount")}</th><th>{t(register?"exp.source":"exp.actions")}</th>{register&&<th>{t("exp.actions")}</th>}</tr></thead><tbody>{visible.map((row)=><tr key={row.id}><td><bdi>{row.date.replace("T"," ")}</bdi></td><td><strong>{register?row.description||row.source_id.slice(0,12):row.title}</strong>{!register&&row.notes&&<small className="exp-cell-note" title={row.notes}>{row.notes}</small>}</td><td>{t(`exp.${row.category}`)}</td>{tab==="WITHDRAWAL"&&<td>{row.person}</td>}<td className="exp-number">{money(row.amount,row.currency)}</td><td><span className={`exp-badge ${register?row.direction==="IN"?"positive":"negative":row.payment_source==="cash"?"positive":"neutral"}`}>{t(`exp.${register?row.direction:row.payment_source}`)}</span></td><td className="exp-number">{money(row.amount_afn)}</td><td>{register?<div className="exp-source"><span>{t(`exp.${row.category}`)}</span><bdi title={row.source_id}>{row.source_id.slice(0,12)}</bdi></div>:documentActions(row)}</td>{register&&<td>{cashActions(row)}</td>}</tr>)}{!visible.length&&<tr><td colSpan={register||tab==="WITHDRAWAL"?8:7}><div className="exp-empty"><LuReceipt/>{t("exp.empty")}</div></td></tr>}</tbody></table></div>}
   <footer className="exp-pagination"><span>{number(rows.length)} · {number(currentPage+1)} / {number(pages)}</span><div><button className="exp-button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>{t("exp.previous")}</button><button className="exp-button" disabled={currentPage>=pages-1} onClick={()=>setPage(currentPage+1)}>{t("exp.next")}</button></div></footer>
  </section>
  {transaction&&<div className="exp-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)setTransaction(null);}}><section className="exp-dialog" role="dialog" aria-modal="true" aria-labelledby="exp-transaction-title"><header><div><span>{t(`exp.${transaction.category}`)}</span><h2 id="exp-transaction-title">{t("exp.transactionDetails")}</h2></div><button type="button" className="exp-icon" aria-label={t("exp.close")} onClick={()=>setTransaction(null)}><LuX/></button></header><div className="exp-transaction-body"><dl className="exp-transaction-details">{[
   ["transactionId",<bdi>{transaction.id}</bdi>],["date",<bdi>{transaction.date.replace("T"," ")}</bdi>],["direction",t(`exp.${transaction.direction}`)],["category",t(`exp.${transaction.category}`)],
   ["amount",money(transaction.amount,transaction.currency)],["rate",number(transaction.exchange_rate)],["basisAmount",money(transaction.amount_afn)],["reference",<bdi>{transaction.source_id}</bdi>],["notes",transaction.description||"?"],["createdAt",<bdi>{transaction.created_at}</bdi>],
  ].map(([key,value])=><div key={key}><dt>{t(`exp.${key}`)}</dt><dd>{value}</dd></div>)}</dl>{cashSourceTarget(transaction)&&<p className="exp-note">{t("exp.linkedNote")}</p>}<footer>{cashSourceTarget(transaction)&&onOpenSource&&<button type="button" className="exp-button exp-primary" onClick={()=>onOpenSource({...cashSourceTarget(transaction),action:"view"})}>{t("exp.openOriginal")}</button>}<button type="button" className="exp-button" onClick={()=>setTransaction(null)}>{t("exp.close")}</button></footer></div></section></div>}
  {form&&<div className="exp-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget&&!busy&&!historyLoading)setForm(null);}}><section className="exp-dialog" role="dialog" aria-modal="true" aria-labelledby="exp-dialog-title"><header><div><span>{t(`exp.${form.kind}`)}</span><h2 id="exp-dialog-title">{readOnly?form.title:form.revision?t("exp.edit"):t(form.kind==="DEPOSIT"?"exp.newDeposit":form.kind==="EXPENSE"?"exp.newExpense":"exp.newWithdrawal")}</h2></div><button className="exp-icon" disabled={busy||historyLoading} aria-label={t("exp.close")} onClick={()=>setForm(null)}><LuX/></button></header><form onSubmit={save}><fieldset disabled={readOnly||busy}><div className="exp-form-grid"><label className="exp-wide"><span>{t("exp.titleField")} *</span><input autoFocus required maxLength={300} value={form.title} onChange={(e)=>editField("title",e.target.value)}/></label>{form.kind==="EXPENSE"&&<label><span>{t("exp.category")}</span><select value={form.category} onChange={(e)=>editField("category",e.target.value)}>{categories.map((key)=><option key={key} value={key}>{t(`exp.${key}`)}</option>)}</select></label>}{form.kind==="WITHDRAWAL"&&<label><span>{t("exp.person")} *</span><input required maxLength={300} value={form.person} onChange={(e)=>editField("person",e.target.value)}/></label>}<label><span>{t("exp.date")} *</span><input required type="date" value={form.date} onChange={(e)=>editField("date",e.target.value)}/></label><label><span>{t("exp.amount")} *</span><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(e)=>editField("amount",e.target.value)}/></label><label><span>{t("exp.currency")}</span><select value={form.currency} onChange={(e)=>editField("currency",e.target.value)}><option value="AFN">AFN</option><option value="USD">USD</option></select></label><label><span>{t("exp.source")}</span><select value={form.payment_source} onChange={(e)=>editField("payment_source",e.target.value)}><option value="cash">{t("exp.cash")}</option>{form.kind!=="DEPOSIT"&&<option value="other">{t("exp.other")}</option>}</select></label><label className="exp-wide"><span>{t("exp.notes")}</span><textarea rows={3} maxLength={4000} value={form.notes} onChange={(e)=>editField("notes",e.target.value)}/></label></div></fieldset><div className="exp-form-total"><span>{t("exp.basisAmount")}{form.currency==="USD"&&<small>{t("exp.rate")}: {number(rate)}</small>}</span><strong>{money(moneyRound((Number(form.amount)||0)*rate))}</strong></div>{formError&&<div className="exp-alert" role="alert">{t(formError)}</div>}{readOnly&&<section className="exp-history"><h3>{t("exp.history")}</h3>{historyLoading?<p>{t("exp.loading")}</p>:history.map((item)=><div key={item.revision}><span>{t("exp.revision")} {item.revision}<small><bdi>{item.updated_at}</bdi> · {t(`exp.${item.deleted_at?"deleted":"active"}`)}</small><small>{item.title} · {item.date} · {t(`exp.${item.payment_source}`)}</small></span><strong>{money(item.amount,item.currency)}</strong></div>)}</section>}<footer><button className="exp-button" type="button" disabled={busy||historyLoading} onClick={()=>setForm(null)}>{t("exp.close")}</button>{!readOnly&&<button className="exp-button exp-primary" disabled={busy}>{busy?t("loading"):t("exp.save")}</button>}</footer></form></section></div>}
 </section>;
}
