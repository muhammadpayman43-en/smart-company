import mongoose from "mongoose";

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    databasePath: {type:String,select:false},
    activeSuperAdmins: {type:Number,min:0},
  },
  { timestamps: true },
);

organizationSchema.index({databasePath:1},{unique:true,sparse:true});
export const Organization = mongoose.model("Organization", organizationSchema);
