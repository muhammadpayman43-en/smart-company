import mongoose from "mongoose";
const schema=new mongoose.Schema({organizationId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},senderId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},recipientId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},clientId:{type:String,required:true,maxlength:80},text:{type:String,required:true,maxlength:2000},readAt:{type:Date,default:null}},{timestamps:{createdAt:true,updatedAt:false}});
schema.index({organizationId:1,senderId:1,clientId:1},{unique:true});
schema.index({organizationId:1,senderId:1,recipientId:1,createdAt:-1});
export const ChatMessage=mongoose.model("ChatMessage",schema);
