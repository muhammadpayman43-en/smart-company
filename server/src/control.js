import {networkInterfaces} from "node:os";
import "dotenv/config";
const addresses=Object.entries(networkInterfaces()).flatMap(([name,entries])=>entries.filter(entry=>entry.family==="IPv4"&&!entry.internal&&!entry.address.startsWith("169.254.")).map(entry=>({name,address:entry.address})));
if(process.argv[2]==="--assign"){
 const [{Organization},{connectDatabase},{canonicalDatabasePath,databaseRequest,closeWorkers},{default:mongoose}]=await Promise.all([import("./models/Organization.js"),import("./config/database.js"),import("./database.js"),import("mongoose")]);
 try{
  const id=process.argv[3];if(!mongoose.isValidObjectId(id)||!process.argv[4])throw Error("Usage: node src/control.js --assign ORGANIZATION_ID SQLITE_FILE");
  const databasePath=await canonicalDatabasePath(process.argv[4]);
  const info=await databaseRequest(databasePath,{command:"get_company_info",args:{},write:false,userId:"server-administrator"});if(!info.data?.companyName)throw Error("Invalid medicine database");
  await connectDatabase();const result=await Organization.updateOne({_id:id},{$set:{databasePath}});if(!result.matchedCount)throw Error("Organization not found");
  console.log("Central database assigned.");
 }catch(error){console.error(error.message);process.exitCode=1}finally{closeWorkers();await mongoose.disconnect()}
}else process.stdout.write(JSON.stringify({addresses,port:Number(process.env.PORT||3000),running:false}));
