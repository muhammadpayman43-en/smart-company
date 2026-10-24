import mongoose from "mongoose";
const schema=new mongoose.Schema({organizationId:{type:mongoose.Schema.Types.ObjectId,index:true},userId:mongoose.Schema.Types.ObjectId,action:{type:String,required:true},targetId:String,success:{type:Boolean,default:true}},{timestamps:{createdAt:true,updatedAt:false}});
export const AuditLog=mongoose.model("AuditLog",schema);
