import {Router} from "express";
import bcrypt from "bcryptjs";
import {z} from "zod";
import mongoose from "mongoose";
import {authenticate} from "../middleware/authenticate.js";
import {User} from "../models/User.js";
import {Organization} from "../models/Organization.js";
import {AuditLog} from "../models/AuditLog.js";
import {permits,publicUser,requirePermission} from "../access.js";
import {actions,modules,roles,effectivePermissions} from "../../../src/shared/permissions.js";
import {ensureOwnership} from "./auth.js";

const router=Router();router.use(authenticate,async(req,res,next)=>{try{await ensureOwnership(req.auth.organizationId);const owner=await User.findOne({organizationId:req.auth.organizationId,isOwner:true}).select("_id");if(!owner||String(owner.id)!==String(req.auth.userId))return res.status(403).json({error:"permission_denied"});req.user.isOwner=true;next();}catch(error){next(error)}});
const permissionSchema=z.object(Object.fromEntries(modules.map(module=>[module,z.object(Object.fromEntries([...actions,...(module==="users"?["manage"]:[])].map(action=>[action,z.boolean().optional()]))).strict().optional()]))).strict();
const schema=z.object({fullName:z.string().trim().min(1).max(200).refine(name=>{const [first,...rest]=name.split(/\s+/);return first.length<=100&&rest.join(" ").length<=100}),username:z.string().trim().regex(/^[\p{L}\p{N}_ ]{2,80}$/u).transform(value=>value.replace(/\s+/gu," ").normalize("NFC").toLowerCase()),password:z.string().min(4).max(128).optional(),role:z.enum(roles),active:z.boolean(),permissions:permissionSchema.default({}),revision:z.number().int().positive().optional()}).strict();
const eligible=(actor,input)=>{
 if(actor.role!=="super_admin"&&input.role==="super_admin")return false;
 const granted=effectivePermissions(input);
 return actor.role==="super_admin"||modules.every(module=>Object.entries(granted[module]).every(([action,value])=>!value||permits(actor,module,action)));
};
const isSuper=user=>user.role==="super_admin"&&user.active!==false;
const revisionFilter=user=>!user.revision||user.revision===1?{$or:[{revision:1},{revision:{$exists:false}}]}:{revision:user.revision};
const audit=(req,action,targetId)=>AuditLog.create({organizationId:req.auth.organizationId,userId:req.auth.userId,action,targetId:String(targetId)});

router.get("/",requirePermission("users","view"),async(req,res,next)=>{try{await ensureOwnership(req.auth.organizationId);const users=await User.find({organizationId:req.auth.organizationId}).sort({createdAt:1});res.json({users:users.map(publicUser)});}catch(error){next(error)}});
router.post("/",requirePermission("users","create"),async(req,res,next)=>{
 try{
  const parsed=schema.safeParse(req.body);if(!parsed.success||!parsed.data.password)return res.status(400).json({error:"invalid_request"});
  const input=parsed.data;if(!eligible(req.user,input))return res.status(403).json({error:"permission_denied"});
  const [firstName,...rest]=input.fullName.split(/\s+/),lastName=rest.join(" ")||"—";
  const user=await User.create({organizationId:req.auth.organizationId,firstName,lastName,username:input.username,phone:input.username,passwordHash:await bcrypt.hash(input.password,12),role:input.role,active:input.active,permissions:input.permissions});
  if(isSuper(user))await Organization.updateOne({_id:req.auth.organizationId},{$inc:{activeSuperAdmins:1}});
  await audit(req,"user_created",user.id);res.status(201).json({user:publicUser(user)});
 }catch(error){if(error.code===11000)return res.status(409).json({error:"username_exists"});next(error)}
});
router.put("/:id",requirePermission("users","edit"),async(req,res,next)=>{
 let reserved=false;
 try{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({error:"user_not_found"});
  const parsed=schema.safeParse(req.body);if(!parsed.success||!parsed.data.revision)return res.status(400).json({error:"invalid_request"});
  const input=parsed.data;if(!eligible(req.user,input))return res.status(403).json({error:"permission_denied"});
  const target=await User.findOne({_id:req.params.id,organizationId:req.auth.organizationId});if(!target)return res.status(404).json({error:"user_not_found"});
  if(target.isOwner&&(!input.active||input.role!=="super_admin"))return res.status(409).json({error:"last_super_admin"});
  if((target.revision||1)!==input.revision)return res.status(409).json({error:"revision_conflict"});
  if(target.role==="super_admin"&&req.user.role!=="super_admin")return res.status(403).json({error:"permission_denied"});
  const passwordHash=input.password?await bcrypt.hash(input.password,12):undefined;
  const demoting=isSuper(target)&&!isSuper(input),promoting=!isSuper(target)&&isSuper(input);
  if(demoting){const reservation=await Organization.updateOne({_id:req.auth.organizationId,activeSuperAdmins:{$gte:2}},{$inc:{activeSuperAdmins:-1}});if(reservation.modifiedCount!==1)return res.status(409).json({error:"last_super_admin"});reserved=true;}
  const [firstName,...rest]=input.fullName.split(/\s+/);
  const accessChanged=input.role!==target.role||input.active!==(target.active!==false)||JSON.stringify(effectivePermissions(input))!==JSON.stringify(effectivePermissions(target))||Boolean(passwordHash);
  const user=await User.findOneAndUpdate({_id:target.id,organizationId:req.auth.organizationId,...revisionFilter(target)},{$set:{firstName,lastName:rest.join(" ")||"—",username:input.username,role:input.role,active:input.active,permissions:input.permissions,...(passwordHash?{passwordHash}:{})},$inc:{revision:1,...(accessChanged?{authVersion:1}:{})}},{new:true});
  if(!user){if(demoting)await Organization.updateOne({_id:req.auth.organizationId},{$inc:{activeSuperAdmins:1}});return res.status(409).json({error:"revision_conflict"});}
  if(promoting)await Organization.updateOne({_id:req.auth.organizationId},{$inc:{activeSuperAdmins:1}});
  await audit(req,"user_permissions_changed",user.id);res.json({user:publicUser(user)});
 }catch(error){if(error.code===11000){if(reserved)await Organization.updateOne({_id:req.auth.organizationId},{$inc:{activeSuperAdmins:1}});return res.status(409).json({error:"username_exists"});}next(error)}
});
router.delete("/:id",requirePermission("users","delete"),async(req,res,next)=>{
 try{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({error:"user_not_found"});
  const target=await User.findOne({_id:req.params.id,organizationId:req.auth.organizationId});if(!target)return res.status(404).json({error:"user_not_found"});
  if(target.isOwner)return res.status(409).json({error:"last_super_admin"});
  if(target.role==="super_admin"&&req.user.role!=="super_admin")return res.status(403).json({error:"permission_denied"});
  const revision=Number(req.get("If-Match"));if(!revision||revision!==(target.revision||1))return res.status(409).json({error:"revision_conflict"});
  if(isSuper(target)){const reserved=await Organization.updateOne({_id:req.auth.organizationId,activeSuperAdmins:{$gte:2}},{$inc:{activeSuperAdmins:-1}});if(reserved.modifiedCount!==1)return res.status(409).json({error:"last_super_admin"});}
  const result=await User.deleteOne({_id:target.id,...revisionFilter(target)});
  if(!result.deletedCount){if(isSuper(target))await Organization.updateOne({_id:req.auth.organizationId},{$inc:{activeSuperAdmins:1}});return res.status(409).json({error:"revision_conflict"});}
  await audit(req,"user_deleted",target.id);res.json({deleted:true});
 }catch(error){next(error)}
});
export default router;
