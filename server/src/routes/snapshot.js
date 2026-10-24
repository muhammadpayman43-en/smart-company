import {Router} from "express";
import path from "node:path";
import express from "express";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {authenticate} from "../middleware/authenticate.js";
import {permits} from "../access.js";
import {Organization} from "../models/Organization.js";
import {createDatabaseSnapshot,databaseRequest,replaceDatabaseSnapshot} from "../database.js";
import {SyncEvent} from "../models/SyncEvent.js";

const router=Router();
router.get("/status",authenticate,async(req,res,next)=>{try{const organization=await Organization.findById(req.auth.organizationId).select("+databasePath");if(!organization?.databasePath)return res.status(503).json({error:"database_not_configured"});const revision=(await databaseRequest(organization.databasePath,{command:"get_revision",args:{},write:false,userId:req.auth.userId,organizationId:req.auth.organizationId})).data;res.json({workspaceId:String(organization.id),revision})}catch(error){next(error)}});
router.get("/",authenticate,async(req,res,next)=>{
 try{
  if(!permits(req.user,"settings","view"))return res.status(403).json({error:"permission_denied"});
  const organization=await Organization.findById(req.auth.organizationId).select("+databasePath");
  if(!organization?.databasePath)return res.status(503).json({error:"database_not_configured"});
  const revision=(await databaseRequest(organization.databasePath,{command:"get_revision",args:{},write:false,userId:req.auth.userId,organizationId:req.auth.organizationId})).data;
  const snapshot=await createDatabaseSnapshot(organization.databasePath);
  res.set({"Content-Type":"application/vnd.sqlite3","Content-Disposition":`attachment; filename="smart-company-${organization.id}.sqlite"`,"X-Workspace-Id":String(organization.id),"X-Database-Revision":String(revision),"Cache-Control":"no-store"});
  res.on("finish",snapshot.cleanup);res.on("close",snapshot.cleanup);
  res.sendFile(path.resolve(snapshot.path),error=>{if(error&&!res.headersSent)next(error)});
 }catch(error){next(error)}
});
router.put("/",express.raw({type:"application/octet-stream",limit:"512mb"}),authenticate,async(req,res,next)=>{
 let directory;
 try{
  if(req.user.role!=="super_admin")return res.status(403).json({error:"permission_denied"});
  const workspaceId=req.get("X-Workspace-Id"),syncId=req.get("X-Sync-Id"),baseRevision=Number(req.get("X-Base-Revision"));
  if(workspaceId!==req.auth.organizationId||!syncId||!Number.isSafeInteger(baseRevision)||baseRevision<0||!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:"invalid_request"});
  const existing=await SyncEvent.findOne({organizationId:req.auth.organizationId,eventId:syncId}).lean();if(existing)return existing.data?.status==="complete"?res.json({status:"already_received",revision:existing.data.revision}):res.status(409).json({error:"sync_in_progress"});
  const organization=await Organization.findById(req.auth.organizationId).select("+databasePath");if(!organization?.databasePath)return res.status(503).json({error:"database_not_configured"});
  const current=(await databaseRequest(organization.databasePath,{command:"get_revision",args:{},write:false,userId:req.auth.userId,organizationId:req.auth.organizationId})).data;if(current!==baseRevision)return res.status(409).json({error:"sync_conflict",revision:current});
  await SyncEvent.create({organizationId:req.auth.organizationId,eventId:syncId,entity:"company_info",recordId:`snapshot:${syncId}`,operation:"upsert",data:{status:"processing"}});
  directory=await mkdtemp(path.join(tmpdir(),"smart-company-upload-"));const snapshot=path.join(directory,`${randomUUID()}.sqlite`);await writeFile(snapshot,req.body);
  const revision=current+1;await replaceDatabaseSnapshot(organization.databasePath,snapshot,workspaceId,revision);
  await SyncEvent.updateOne({organizationId:req.auth.organizationId,eventId:syncId},{$set:{data:{status:"complete",revision}}});
  res.json({status:"accepted",revision});
 }catch(error){if(req.get("X-Sync-Id"))await SyncEvent.deleteOne({organizationId:req.auth.organizationId,eventId:req.get("X-Sync-Id"),"data.status":"processing"}).catch(()=>{});next(error)}finally{if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{})}
});
export default router;
