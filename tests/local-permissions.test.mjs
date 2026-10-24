import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {permits,accessiblePage,effectivePermissions} from "../src/shared/permissions.js";
import {calculateDashboardOverview} from "../src/pages/Reports/reportEngine.js";

test("anonymous and inactive identities never receive local owner access",()=>{
 assert.equal(accessiblePage(null,"settings"),false);
 assert.equal(permits(null,"users","manage"),false);
 assert.equal(permits({role:"super_admin",active:false},"users","manage"),false);
 assert.equal(permits({role:"super_admin",active:true},"users","manage"),true);
});
test("explicit permission choices override roles without promoting ordinary users",()=>{
 const normal={role:"viewer",active:true,permissions:{products:{view:false,create:true}}};
 assert.equal(permits(normal,"products","view"),false);assert.equal(permits(normal,"products","create"),true);
 assert.equal(permits(normal,"users","manage"),false);assert.equal(accessiblePage(normal,"settings"),false);
 assert.equal(permits({role:"admin",active:true,permissions:{users:{manage:false}}},"users","manage"),false);
 assert.equal(effectivePermissions({role:"member"}).products.view,true);
});
test("native dashboard contact redaction preserves the existing financial calculations",()=>{
 // Reuse the existing report fixture and the actual native field projection.
 const fixtureSource=readFileSync(new URL("../src/pages/Reports/reportEngine.test.js",import.meta.url),"utf8").match(/function fixture\(\) \{[\s\S]*?\n\}/)[0];
 const native=readFileSync(new URL("../src-tauri/src/local_users.rs",import.meta.url),"utf8").match(/record\.retain\([\s\S]*?\)\);/)[0];
 const fields=new Set([...native.matchAll(/"([^"]+)"/g)].map(value=>value[1]));
 assert.ok(fields.has("customer_name"));
 for(const today of ["2026-10-20","2026-10-30"]){
  const data=runInNewContext(`(${fixtureSource})`)();data.today=today;
  const expected=calculateDashboardOverview(data),redacted=structuredClone(data);
  for(const records of Object.values(redacted))if(Array.isArray(records))for(const record of records)for(const field of fields)delete record[field];
  assert.deepEqual(calculateDashboardOverview(redacted),expected);
 }
});
