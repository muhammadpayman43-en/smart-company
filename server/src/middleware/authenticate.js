import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import {User} from "../models/User.js";

export async function authenticate(req, res, next) {
  const authorization = req.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  if (!token) {
    return res.status(401).json({ error: "authentication_required" });
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (!mongoose.isValidObjectId(payload.userId) || !mongoose.isValidObjectId(payload.organizationId)) {
      return res.status(401).json({ error: "invalid_token" });
    }

    req.auth = {
      userId: payload.userId,
      organizationId: payload.organizationId,
      role: payload.role,
    };
    const user=await User.findOne({_id:payload.userId,organizationId:payload.organizationId});
    if(!user||user.active===false||(user.authVersion||0)!==(payload.authVersion||0))return res.status(401).json({error:"session_expired"});
    req.user=user;
    req.auth.role=user.role;
    next();
  } catch(error) {
    if(error?.name!=="JsonWebTokenError"&&error?.name!=="TokenExpiredError"&&error?.name!=="NotBeforeError")return next(error);
    return res.status(401).json({ error: "invalid_token" });
  }
}
