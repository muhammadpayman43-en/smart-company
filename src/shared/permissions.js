// One policy is shared by React, Express and the native SQLite authorization boundary.
import config from "./permission-config.json" with {type:"json"};
export const {modules,actions,roles,rolePermissions,commandAccess}=config;
export function effectivePermissions(user) {
  const role=user?.role==="member"?"viewer":user?.role;
  const base=rolePermissions[role]||{};
  return Object.fromEntries(modules.map(module=>[module,Object.fromEntries([...actions,...(module==="users"?["manage"]:[])].map(action=>[action,role==="super_admin"?true:(user?.permissions?.[module]?.[action] ?? base[module]?.[action] ?? false)]))]));
}
export function permits(user,module,action="view") {return Boolean(user)&&user.active!==false&&Boolean(effectivePermissions(user)[module]?.[action]);}
export const pageModule=page=>page==="companies"?"suppliers":page==="expenses"?"expenses":page;
export function accessiblePage(user,page) {
  if(!user)return false;
  if(page==="expenses")return ["expenses","withdrawals","cash_register"].some(m=>permits(user,m));
  if(page==="settings")return permits(user,"settings")||permits(user,"users","manage");
  return permits(user,pageModule(page));
}
export const mutationCommands = new Set(Object.keys(commandAccess).filter(key=>/^(create_|update_|delete_|record_|return_|cancel_|save_|import_)/.test(key)));
