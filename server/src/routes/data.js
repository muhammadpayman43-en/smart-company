import {Router} from "express";
import {createHash} from "node:crypto";
import {z} from "zod";
import {authenticate} from "../middleware/authenticate.js";
import {permits} from "../access.js";
import {Organization} from "../models/Organization.js";
import {databaseRequest} from "../database.js";
import {commandAccess,mutationCommands} from "../../../src/shared/permissions.js";
import {calculateDashboardOverview} from "../../../src/pages/Reports/reportEngine.js";
const router=Router();router.use(authenticate);
const schema=z.object({args:z.record(z.string(),z.unknown()).default({})}).strict();
const documentModule=kind=>kind==="WITHDRAWAL"?"withdrawals":kind==="DEPOSIT"?"cash_register":"expenses";
router.post("/:command",async(req,res,next)=>{
 try{
  const command=req.params.command;if(!Object.hasOwn(commandAccess,command))return res.status(404).json({error:"unknown_command"});
  const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"invalid_request"});
  const args=parsed.data.args;
  if(Object.hasOwn(args,"payload")&&(!args.payload||typeof args.payload!=="object"||Array.isArray(args.payload)))return res.status(400).json({error:"invalid_request"});
  // File locations, SQL and organization identifiers are never accepted from a client.
  delete args.databasePath;if(args.payload&&typeof args.payload==="object")delete args.payload.databasePath;
  const write=mutationCommands.has(command);
  const requestId=req.get("Idempotency-Key");if(write&&!z.string().uuid().safeParse(requestId).success)return res.status(400).json({error:"request_id_required"});
  let access=commandAccess[command];
  const referenceCompanies=command==="list_pharmaceutical_companies"&&!permits(req.user,"suppliers")&&permits(req.user,"products");
  if(referenceCompanies)access=null;
  if(command==="get_cash_register"){
   if(!["expenses","withdrawals","cash_register"].some(m=>permits(req.user,m)))return res.status(403).json({error:"permission_denied"});
   access=null;
  }
  if(command==="list_expiry_alerts"&&permits(req.user,"settings"))access=null;
  if(command==="save_cash_document")access=[documentModule(args.payload?.kind),args.payload?.expectedRevision==null?"create":"edit"];
  if(!["delete_cash_document","get_cash_document_history"].includes(command)&&access&&!permits(req.user,...access))return res.status(403).json({error:"permission_denied",module:access[0],action:access[1]});
  const organization=await Organization.findById(req.auth.organizationId).select("+databasePath");
  if(!organization?.databasePath)return res.status(503).json({error:"database_not_configured"});
  const call=payload=>(req.app.locals.databaseRequest||databaseRequest)(organization.databasePath,{userId:req.auth.userId,organizationId:req.auth.organizationId,...payload});
  if(["delete_cash_document","get_cash_document_history"].includes(command)){
   const current=await call({command:"get_cash_register",args:{},write:false});
   const document=current.data.documents.find(d=>d.id===args.id);if(!document)return res.status(404).json({error:"document_not_found"});
   access=[documentModule(document.kind),command==="delete_cash_document"?"delete":"view"];
   if(!permits(req.user,...access))return res.status(403).json({error:"permission_denied"});
  }
  const header=req.get("If-Match"),expectedRevision=header===undefined?undefined:Number(header.replace(/^"(\d+)"$/,"$1"));
  if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0))return res.status(400).json({error:"invalid_revision"});
  const fingerprint=createHash("sha256").update(JSON.stringify({command,args})).digest("hex");
  const result=await call({command,args,write,requestId,fingerprint,expectedRevision});
  if(command!=="get_revision"){
   if(Array.isArray(result.data))result.data=result.data.map(row=>({...row,_apiRevision:result.revision}));
   else if(result.data&&typeof result.data==="object")result.data._apiRevision=result.revision;
  }
  if(command==="get_dashboard_data")result.data={today:result.data.today,overview:calculateDashboardOverview(result.data),cashBalance:result.data.cashTransactions.reduce((sum,row)=>sum+(row.direction==="IN"?row.amount_afn:-row.amount_afn),0)};
  if(referenceCompanies)result.data=result.data.map(({id,name})=>({id,name}));
  if(["list_medicines","create_medicine","update_medicine"].includes(command)&&!permits(req.user,"purchases")){
   const sanitize=record=>({...record,purchasePrice:0});result.data=Array.isArray(result.data)?result.data.map(sanitize):sanitize(result.data);
  }
  if(command==="get_cash_register"){
   result.data.documents=result.data.documents.filter(document=>permits(req.user,documentModule(document.kind)));
   if(!permits(req.user,"cash_register"))result.data.transactions=[];
  }
  res.set("ETag",`"${result.revision}"`);res.json(result);
 }catch(error){
  const code=error.code||error.message;
  if(["revision_conflict","cash_revision_conflict","idempotency_conflict"].includes(code))return res.status(409).json({error:code});
  if(error.status)return res.status(error.status).json({error:code});
  if(/^[a-z][a-z0-9_]+$/.test(code))return res.status(/not_found/.test(code)?404:400).json({error:code});
  next(error);
 }
});
export default router;
