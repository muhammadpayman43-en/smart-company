import mongoose from "mongoose";

export const syncEntities = [
  "company_info",
  "admin_users",
  "products",
  "categories",
  "customers",
  "suppliers",
  "purchases",
  "sales",
  "inventory",
  "warehouses",
  "expenses",
  "cash_transactions",
];

const syncEventSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    eventId: { type: String, required: true },
    entity: { type: String, enum: syncEntities, required: true },
    recordId: { type: String, required: true },
    operation: { type: String, enum: ["upsert", "delete"], required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

syncEventSchema.index({ organizationId: 1, eventId: 1 }, { unique: true });
syncEventSchema.index({ organizationId: 1, _id: 1 });

export const SyncEvent = mongoose.model("SyncEvent", syncEventSchema);