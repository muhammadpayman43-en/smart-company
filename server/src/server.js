import { app } from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import {networkInterfaces} from "node:os";
import {createHash} from "node:crypto";
import bcrypt from "bcryptjs";
import {Organization} from "./models/Organization.js";
import {User} from "./models/User.js";
import {canonicalDatabasePath,closeWorkers,workerAvailable} from "./database.js";
import {ensureOwnership} from "./routes/auth.js";
import {attachChat} from "./chat.js";

async function bootstrapDesktop() {
  if(!process.argv.includes("--desktop-server"))return;
  let input="";for await(const chunk of process.stdin){input+=chunk;if(input.length>16384)throw Error("invalid_bootstrap");}
  const owner=JSON.parse(input);
  owner.databasePath=await canonicalDatabasePath(owner.databasePath);
  const mapped=await Organization.findOne({databasePath:owner.databasePath});
  const organizationId=mapped?.id||createHash("sha256").update(owner.organizationKey).digest("hex").slice(0,24);
  const previous=await Organization.findById(organizationId);
  if(!previous){
    const organization=await Organization.create({_id:organizationId,name:owner.companyName,databasePath:owner.databasePath,activeSuperAdmins:1});
    const desired=owner.phone.toLowerCase(),username=await User.exists({username:desired})?`${desired}_${organizationId.slice(-6)}`:desired;
    try {await User.create({organizationId,firstName:owner.firstName,lastName:owner.lastName,phone:owner.phone,username,passwordHash:await bcrypt.hash(owner.password,12),role:"super_admin",isOwner:true});}
    catch(error){await Organization.findByIdAndDelete(organization.id);throw error;}
  }else{
    await ensureOwnership(organizationId);
    await Organization.updateOne({_id:organizationId},{$set:{databasePath:owner.databasePath}});
  }
  process.env.LAN_ORGANIZATION_ID=organizationId;
  const administrator=await User.findOne({organizationId,phone:owner.phone});
  return {username:administrator?.username||owner.phone,organizationId};
}

try {
  await connectDatabase();
  const addresses=Object.values(networkInterfaces()).flat().filter(Boolean).map(entry=>entry.address);
  if(env.SERVER_MODE==="cloud"){
    if(!env.PUBLIC_API_URL||new URL(env.PUBLIC_API_URL).protocol!=="https:")throw Error("Cloud mode requires a PUBLIC_API_URL with HTTPS and a TLS reverse proxy.");
  }else if(!["127.0.0.1","::1"].includes(env.API_HOST)&&(env.LAN_ENABLED!=="true"||!addresses.includes(env.API_HOST)))throw Error("Select a local adapter and explicitly enable LAN_ENABLED before exposing the API.");
  const identity=await bootstrapDesktop();
  const server=app.listen(env.PORT, env.API_HOST, () => {
    console.log(JSON.stringify({ready:true,address:`http://${env.API_HOST}:${env.PORT}`,port:env.PORT,centralDatabase:workerAvailable(),username:identity?.username,organizationId:identity?.organizationId}));
  });
  const chat=attachChat(server);
  server.on("error",error=>{console.error("API listener:",error.message);closeWorkers();process.exitCode=1;});
  for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{closeWorkers();chat.close();server.close();process.exit(0)});
  process.on("exit",closeWorkers);
} catch (error) {
  console.error("Could not start API:", error.message);
  process.exitCode = 1;
}

