import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate.js";
import { SyncEvent, syncEntities } from "../models/SyncEvent.js";
import {requirePermission,permits} from "../access.js";
const entityModule={company_info:"settings",products:"products",categories:"products",customers:"customers",suppliers:"suppliers",purchases:"purchases",sales:"sales",inventory:"inventory",warehouses:"inventory",expenses:"expenses",cash_transactions:"cash_register"};

const router = Router();
const pushSchema = z.object({
  changes: z.array(z.object({
    eventId: z.string().uuid(),
    entity: z.enum(syncEntities),
    recordId: z.string().min(1).max(160),
    operation: z.enum(["upsert", "delete"]),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
  })).min(1).max(100),
});

router.use(authenticate,requirePermission("settings","edit"));

router.get("/pull", async (req, res, next) => {
  try {
    const since = req.query.cursor || "";
    if (since && !mongoose.isValidObjectId(since)) {
      return res.status(400).json({ error: "invalid_cursor" });
    }

    const query = { organizationId: req.auth.organizationId,entity:{$in:Object.keys(entityModule).filter(entity=>permits(req.user,entityModule[entity]))} };
    if (since) query._id = { $gt: new mongoose.Types.ObjectId(since) };

    const events = await SyncEvent.find(query).sort({ _id: 1 }).limit(500).lean();
    const changes = events.map(({ _id, eventId, entity, recordId, operation, data, createdAt }) => ({
      cursor: _id.toString(),
      eventId,
      entity,
      recordId,
      operation,
      data,
      createdAt,
    }));

    return res.json({ changes, nextCursor: changes.at(-1)?.cursor ?? (since || null) });
  } catch (error) {
    next(error);
  }
});

router.post("/push", async (req, res, next) => {
  try {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const results = [];
    for (const change of parsed.data.changes) {
      const module=entityModule[change.entity];
      if(!module||!permits(req.user,module,"view")||!permits(req.user,module,change.operation==="delete"?"delete":"create")||(change.operation!=="delete"&&!permits(req.user,module,"edit")))return res.status(403).json({error:"permission_denied"});
      try {
        const event = await SyncEvent.create({
          organizationId: req.auth.organizationId,
          ...change,
        });
        results.push({ eventId: change.eventId, status: "accepted", cursor: event.id });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await SyncEvent.findOne({
          organizationId: req.auth.organizationId,
          eventId: change.eventId,
        }).select("_id");
        results.push({ eventId: change.eventId, status: "already_received", cursor: existing?.id });
      }
    }

    return res.json({ results });
  } catch (error) {
    next(error);
  }
});

export default router;
