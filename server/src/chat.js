import {Router} from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import {WebSocketServer,WebSocket} from "ws";
import {env} from "./config/env.js";
import {authenticate} from "./middleware/authenticate.js";
import {User} from "./models/User.js";
import {ChatMessage} from "./models/ChatMessage.js";
import {publicUser} from "./access.js";

const clients=new Map(),key=(org,user)=>`${org}:${user}`;
const online=(org,user)=>Boolean(clients.get(key(org,user))?.size);
const message=value=>({id:String(value.id),clientId:value.clientId,senderId:String(value.senderId),recipientId:String(value.recipientId),text:value.text,createdAt:value.createdAt,readAt:value.readAt});
const send=(socket,data)=>socket.readyState===WebSocket.OPEN&&socket.send(JSON.stringify(data));
const deliver=(org,user,data)=>clients.get(key(org,user))?.forEach(socket=>send(socket,data));
const presence=async org=>{const users=await User.find({organizationId:org,active:{$ne:false}}).select("_id");const data={type:"presence",onlineUserIds:users.filter(user=>online(org,String(user.id))).map(user=>String(user.id))};for(const user of users)deliver(org,String(user.id),data)};

export const chatRouter=Router();chatRouter.use(authenticate);
chatRouter.get("/users",async(req,res,next)=>{try{const [users,unread]=await Promise.all([User.find({organizationId:req.auth.organizationId,active:{$ne:false},_id:{$ne:req.auth.userId}}).sort({firstName:1,lastName:1}),ChatMessage.aggregate([{$match:{organizationId:new mongoose.Types.ObjectId(req.auth.organizationId),recipientId:new mongoose.Types.ObjectId(req.auth.userId),readAt:null}},{$group:{_id:"$senderId",count:{$sum:1}}}])]);const counts=new Map(unread.map(row=>[String(row._id),row.count]));res.json({users:users.map(user=>({...publicUser(user),online:online(req.auth.organizationId,String(user.id)),unread:counts.get(String(user.id))||0}))});}catch(error){next(error)}});
chatRouter.get("/history/:userId",async(req,res,next)=>{try{if(!mongoose.isValidObjectId(req.params.userId))return res.status(400).json({error:"invalid_request"});const peer=await User.exists({_id:req.params.userId,organizationId:req.auth.organizationId,active:{$ne:false}});if(!peer)return res.status(404).json({error:"user_not_found"});const scope={organizationId:req.auth.organizationId,$or:[{senderId:req.auth.userId,recipientId:req.params.userId},{senderId:req.params.userId,recipientId:req.auth.userId}]};const rows=await ChatMessage.find(scope).sort({createdAt:-1}).limit(100);await ChatMessage.updateMany({organizationId:req.auth.organizationId,senderId:req.params.userId,recipientId:req.auth.userId,readAt:null},{$set:{readAt:new Date()}});res.json({messages:rows.reverse().map(message)});}catch(error){next(error)}});

export function attachChat(server){
 const sockets=new WebSocketServer({server,path:"/api/v1/chat",maxPayload:8192});
 sockets.on("connection",async(socket,request)=>{let user,org,id;try{const token=new URL(request.url,"http://localhost").searchParams.get("token"),payload=jwt.verify(token||"",env.JWT_SECRET);user=await User.findOne({_id:payload.userId,organizationId:payload.organizationId,active:{$ne:false}});if(!user||(user.authVersion||0)!==(payload.authVersion||0))throw Error();org=String(user.organizationId);id=String(user.id);}catch{socket.close(1008,"authentication_required");return}
  const entry=clients.get(key(org,id))||new Set();entry.add(socket);clients.set(key(org,id),entry);
  socket.on("message",async raw=>{let input;try{input=JSON.parse(raw.toString());if(input.type==="read"&&mongoose.isValidObjectId(input.userId)){await ChatMessage.updateMany({organizationId:org,senderId:input.userId,recipientId:id,readAt:null},{$set:{readAt:new Date()}});return}if(input.type!=="send"||!mongoose.isValidObjectId(input.recipientId)||!/^[-\w]{8,80}$/.test(input.clientId||""))return send(socket,{type:"error",clientId:input.clientId,error:"invalid_message"});const text=String(input.text||"").trim();if(!text||[...text].length>2000)return send(socket,{type:"error",clientId:input.clientId,error:"invalid_message"});if(!await User.exists({_id:input.recipientId,organizationId:org,active:{$ne:false}}))return send(socket,{type:"error",clientId:input.clientId,error:"user_not_found"});let saved=await ChatMessage.findOne({organizationId:org,senderId:id,clientId:input.clientId});if(!saved)try{saved=await ChatMessage.create({organizationId:org,senderId:id,recipientId:input.recipientId,clientId:input.clientId,text})}catch(error){if(error?.code===11000)saved=await ChatMessage.findOne({organizationId:org,senderId:id,clientId:input.clientId});else throw error}if(!saved)return send(socket,{type:"error",clientId:input.clientId,error:"invalid_message"});const data={type:"message",message:message(saved)};deliver(org,id,data);deliver(org,String(saved.recipientId),data);}catch(error){send(socket,{type:"error",clientId:input?.clientId,error:"invalid_message"})}});
  socket.on("close",()=>{const entry=clients.get(key(org,id));entry?.delete(socket);if(!entry?.size)clients.delete(key(org,id));presence(org).catch(()=>{})});send(socket,{type:"ready"});presence(org).catch(()=>{});
 });return sockets;
}
