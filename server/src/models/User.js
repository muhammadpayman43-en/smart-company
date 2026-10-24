import mongoose from "mongoose";
import { roles } from "../../../src/shared/permissions.js";

const userSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    username: {type:String,trim:true,lowercase:true,maxlength:80},
    role: { type: String, enum: [...roles,"member"], default: "viewer" },
    active: {type:Boolean,default:true},
    permissions: {type:mongoose.Schema.Types.Mixed,default:{}},
    authVersion: {type:Number,default:0},
    revision: {type:Number,default:1},
    isOwner: {type:Boolean,default:false,immutable:true},
  },
  { timestamps: true },
);

userSchema.index({ organizationId: 1, phone: 1 }, { unique: true });
userSchema.index({username:1},{unique:true,sparse:true});

export const User = mongoose.model("User", userSchema);
