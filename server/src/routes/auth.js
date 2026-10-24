import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { Organization } from "../models/Organization.js";
import { User } from "../models/User.js";
import {AuditLog} from "../models/AuditLog.js";
import {authenticate} from "../middleware/authenticate.js";
import {publicUser} from "../access.js";
import {initializeDatabase,workerAvailable} from "../database.js";

const router = Router();
const loginAttempts=new Map();
const limitLogin=(req,res,next)=>{
  const now=Date.now(),key=req.ip||"unknown";let entry=loginAttempts.get(key);
  if(!entry||entry.until<=now){entry={count:0,until:now+60000};if(loginAttempts.size>=10000)loginAttempts.delete(loginAttempts.keys().next().value);loginAttempts.set(key,entry);}
  if(++entry.count>30)return res.set("Retry-After",String(Math.ceil((entry.until-now)/1000))).status(429).json({error:"too_many_attempts"});
  next();
};

const registerSchema = z.object({
  companyName: z.string().trim().min(1).max(160),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(5).max(32),
  password: z.string().min(4).max(128),
  username:z.string().trim().regex(/^[\p{L}\p{N}_ ]{2,80}$/u).optional(),
});

const loginSchema = z.object({
  organizationId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  phone: z.string().trim().min(1).max(80).optional(),
  username:z.string().trim().min(1).max(80).optional(),
  central:z.boolean().optional(),
  password: z.string().min(1).max(128),
});

export function issueToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      organizationId: user.organizationId.toString(),
      role: user.role,
      authVersion:user.authVersion||0,
    },
    env.JWT_SECRET,
    { expiresIn: "12h" },
  );
}

router.post("/register", async (req, res, next) => {
  try {
    if(process.env.LAN_ORGANIZATION_ID)return res.status(403).json({error:"registration_disabled"});
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const input = parsed.data;
    const passwordHash = await bcrypt.hash(input.password, 12);
    if(!workerAvailable())return res.status(503).json({error:"database_unavailable"});
    const organization = await Organization.create({ name: input.companyName,activeSuperAdmins:1 });

    try {
      const user = await User.create({
        organizationId: organization.id,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        passwordHash,
        role: "super_admin",
        username:(input.username||input.phone).trim().replace(/\s+/gu," ").normalize("NFC").toLowerCase(),
        isOwner:true,
      });
      const databasePath=await initializeDatabase(organization,input);
      await Organization.updateOne({_id:organization.id},{$set:{databasePath}});

      return res.status(201).json({
        token: issueToken(user),
        organization: { id: organization.id, name: organization.name },
        user: publicUser(user),
      });
    } catch (error) {
      await Organization.findByIdAndDelete(organization.id);
      await User.deleteMany({organizationId:organization.id});
      if (error?.code === 11000) {
        return res.status(409).json({ error: "phone_already_registered" });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

router.post("/login", limitLogin, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { password } = parsed.data;
    const identifier=(parsed.data.username||parsed.data.phone||"").trim().replace(/\s+/gu," ").normalize("NFC").toLowerCase();
    const organizationId=process.env.LAN_ORGANIZATION_ID||parsed.data.organizationId;
    const scope=organizationId?{organizationId}:{};
    const named=identifier?await User.findOne({username:identifier,...scope}).select("+passwordHash"):null;
    const matches=named?[named]:identifier?await User.find({phone:identifier,...(parsed.data.phone&&organizationId?{}:{username:{$exists:false}}),...scope}).select("+passwordHash").limit(2):[];
    const user=matches.length===1?matches[0]:null;
    if (!user || user.active===false || !(await bcrypt.compare(password, user.passwordHash))) {
      await AuditLog.create({organizationId,userId:user?.id,action:"login_failed",success:false});
      return res.status(401).json({ error: "invalid_credentials" });
    }
    await ensureOwnership(user.organizationId);
    await user.populate({path:"organizationId",select:"+databasePath"});
    const organization=user.organizationId;
    if(parsed.data.central&&!organization?.databasePath)return res.status(503).json({error:"database_not_configured"});
    user.organizationId=organization._id;
    // Ownership migration may have promoted this legacy account.
    const current=await User.findById(user.id);
    await AuditLog.create({organizationId:organization.id,userId:user.id,action:"login"});

    return res.json({
      token: issueToken(current),
      organization: { id: organization.id,name:organization.name },
      user: publicUser(current),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me",authenticate,async(req,res,next)=>{try{const organization=await Organization.findById(req.auth.organizationId);res.json({user:publicUser(req.user),organization:{id:organization.id,name:organization.name}});}catch(error){next(error)}});

export async function ensureOwnership(organizationId) {
  const organization=await Organization.findById(organizationId);if(!organization)return;
  if(await User.exists({organizationId,isOwner:true}))return;
  const owner=await User.findOne({organizationId}).sort({createdAt:1,_id:1});
  if(owner){await User.collection.updateOne({_id:owner._id},{$set:{role:"super_admin",active:true,isOwner:true}});await Organization.updateOne({_id:organizationId},{$set:{activeSuperAdmins:Math.max(1,organization.activeSuperAdmins||0)}});}
}

export default router;
