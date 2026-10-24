import {effectivePermissions,permits} from "../../src/shared/permissions.js";
export {permits};
export const publicUser=user=>({id:String(user.id||user._id),organizationId:String(user.organizationId),firstName:user.firstName,lastName:user.lastName,fullName:`${user.firstName} ${user.lastName}`.trim(),username:user.username||user.phone,phone:user.phone,role:user.role==="member"?"viewer":user.role,active:user.active!==false,isOwner:user.isOwner===true,permissions:user.permissions||{},effectivePermissions:effectivePermissions(user),revision:user.revision||1});
export const requirePermission=(module,action="view")=>(req,res,next)=>permits(req.user,module,action)?next():res.status(403).json({error:"permission_denied",module,action});
