import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { clientOrigins } from "./config/env.js";
import authRoutes from "./routes/auth.js";
import syncRoutes from "./routes/sync.js";
import dataRoutes from "./routes/data.js";
import userRoutes from "./routes/users.js";
import {env} from "./config/env.js";
import {workerAvailable} from "./database.js";
import {chatRouter} from "./chat.js";
import snapshotRoutes from "./routes/snapshot.js";


export const app = express();

app.disable("x-powered-by");
// Environment variables are strings; Express requires a number for hop counts.
if(env.TRUST_PROXY){const trustProxy=env.TRUST_PROXY.trim();app.set("trust proxy",/^\d+$/.test(trustProxy)?Number(trustProxy):trustProxy);}
app.use(helmet());
app.use(cors({ origin: clientOrigins }));
app.use(express.json({ limit: "256kb" }));
app.use("/api/v1",(req,res,next)=>env.SERVER_MODE==="cloud"&&!req.secure?res.status(426).json({error:"https_required"}):next());

app.get("/health", (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "database_unavailable",
    database: databaseConnected ? "connected" : "disconnected",
    apiVersion:1,
    capabilities:{centralDatabase:workerAvailable(),rbac:true},
    port:env.PORT,
  });
});

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/sync", syncRoutes);
app.use("/api/v1/data",dataRoutes);
app.use("/api/v1/users",userRoutes);
app.use("/api/v1/chat",chatRouter);
app.use("/api/v1/snapshot",snapshotRoutes);

app.use((error, _req, res, _next) => {
  console.error("API request failed:", error);
  res.status(500).json({ error: "internal_server_error" });
});
