use argon2::{Argon2,password_hash::{PasswordHasher,SaltString}};
use rusqlite::{params,Connection};
use serde_json::{json,Value};
use std::{fs,path::PathBuf};
use tauri::{AppHandle,Manager};
use uuid::Uuid;
use crate::sqlite_backup;

fn endpoint(address:&str,path:&str)->Result<String,String>{
 let url=reqwest::Url::parse(address).map_err(|_|"invalid_server_address")?;
 let private=url.host_str().is_some_and(|host|host=="localhost"||host=="127.0.0.1"||host.starts_with("10.")||host.starts_with("192.168.")||host.starts_with("172."));
 if url.scheme()!="https"&&!private{return Err("https_required".into())}
 Ok(format!("{}{}",address.trim_end_matches('/'),path))
}

#[tauri::command]
pub(crate) async fn initialize_offline_database(app:AppHandle,server_address:String,server_token:String,workspace_id:String,password:String)->Result<Value,String>{
 if workspace_id.len()!=24||!workspace_id.chars().all(|c|c.is_ascii_hexdigit())||password.chars().count()<4{return Err("invalid_request".into())}
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|_|"connection_failed")?;
 let me:Value=client.get(endpoint(&server_address,"/api/v1/auth/me")?).bearer_auth(&server_token).send().await.map_err(|_|"connection_failed")?.error_for_status().map_err(|_|"authentication_required")?.json().await.map_err(|_|"api_incompatible")?;
 if me["organization"]["id"].as_str()!=Some(&workspace_id){return Err("workspace_mismatch".into())}
 let response=client.get(endpoint(&server_address,"/api/v1/snapshot")?).bearer_auth(&server_token).send().await.map_err(|_|"connection_failed")?.error_for_status().map_err(|error|if error.status()==Some(reqwest::StatusCode::FORBIDDEN){"permission_denied"}else{"snapshot_failed"})?;
 if response.headers().get("x-workspace-id").and_then(|v|v.to_str().ok())!=Some(workspace_id.as_str()){return Err("workspace_mismatch".into())}
 if response.content_length().is_some_and(|size|size>512*1024*1024){return Err("snapshot_too_large".into())}
 let revision=response.headers().get("x-database-revision").and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<i64>().ok()).unwrap_or(0);
 let bytes=response.bytes().await.map_err(|_|"snapshot_failed")?;
 if bytes.len()>512*1024*1024{return Err("snapshot_too_large".into())}
 let folder=app.path().app_data_dir().map_err(|_|"snapshot_failed")?.join("offline-workspaces");fs::create_dir_all(&folder).map_err(|_|"snapshot_failed")?;
 let destination=folder.join(format!("{workspace_id}.sqlite"));if destination.exists(){return Err("offline_database_exists".into())}
 let temporary:PathBuf=folder.join(format!(".{workspace_id}.download"));fs::write(&temporary,&bytes).map_err(|_|"snapshot_failed")?;
 let result=(||{
  let mut db=Connection::open(&temporary).map_err(|_|"invalid_database_file")?;
  let integrity:String=db.query_row("PRAGMA integrity_check",[],|row|row.get(0)).map_err(|_|"invalid_database_file")?;if integrity!="ok"{return Err("invalid_database_file".into())}
  let user=&me["user"];let full=user["fullName"].as_str().unwrap_or("").trim();let mut names=full.split_whitespace();let first=names.next().unwrap_or("User");let last=names.collect::<Vec<_>>().join(" ");let user_id=user["id"].as_str().ok_or("api_incompatible")?;let username=user["username"].as_str().unwrap_or("user");let phone=user["phone"].as_str().map(str::to_owned).unwrap_or_else(||format!("cloud:{user_id}"));
  let salt=SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|_|"snapshot_failed")?;let hash=Argon2::default().hash_password(password.as_bytes(),&salt).map_err(|_|"snapshot_failed")?.to_string();
  let tx=db.transaction().map_err(|_|"snapshot_failed")?;
  tx.execute_batch("CREATE TABLE IF NOT EXISTS sync_workspace(workspace_id TEXT PRIMARY KEY,server_address TEXT NOT NULL,base_revision INTEGER NOT NULL DEFAULT 0,last_sync_at TEXT,device_id TEXT NOT NULL);UPDATE sync_outbox SET synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP);").map_err(|_|"snapshot_failed")?;
  tx.execute("INSERT INTO sync_workspace(workspace_id,server_address,base_revision,last_sync_at,device_id) VALUES(?1,?2,?3,CURRENT_TIMESTAMP,?4)",params![workspace_id,server_address,revision,Uuid::new_v4().to_string()]).map_err(|_|"snapshot_failed")?;
  let updated=tx.execute("UPDATE admin_users SET first_name=?1,last_name=?2,password_hash=?3,role=?4,username=?5,active=1,permissions_json=?6 WHERE deleted_at IS NULL AND (username=?5 COLLATE NOCASE OR phone_number=?7)",params![first,last,hash,user["role"].as_str().unwrap_or("viewer"),username,user["permissions"].to_string(),phone]).map_err(|_|"snapshot_failed")?;
  if updated==0{tx.execute("INSERT INTO admin_users(id,first_name,last_name,phone_number,password_hash,role,username,active,permissions_json,is_owner) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,0)",params![user_id,first,last,phone,hash,user["role"].as_str().unwrap_or("viewer"),username,user["permissions"].to_string()]).map_err(|_|"snapshot_failed")?;}
  tx.commit().map_err(|_|"snapshot_failed")?;Ok(())
 })();
 if let Err(error)=result{let _=fs::remove_file(&temporary);return Err(error)}
 fs::rename(&temporary,&destination).map_err(|_|"snapshot_failed")?;
 Ok(json!({"databasePath":destination.to_string_lossy(),"workspaceId":workspace_id,"revision":revision,"size":bytes.len()}))
}

#[derive(Clone)]
struct OfflineUser{values:[String;8],active:i64,revision:i64,auth_version:i64,is_owner:i64,deleted:Option<String>}
fn current_offline_user(db:&Connection,username:&str)->Result<OfflineUser,String>{db.query_row("SELECT id,first_name,last_name,phone_number,password_hash,role,COALESCE(username,''),permissions_json,active,revision,auth_version,is_owner,deleted_at FROM admin_users WHERE username=?1 COLLATE NOCASE",[username],|r|Ok(OfflineUser{values:[r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?],active:r.get(8)?,revision:r.get(9)?,auth_version:r.get(10)?,is_owner:r.get(11)?,deleted:r.get(12)?})).map_err(|_|"authentication_required".into())}

#[tauri::command]
pub(crate) fn get_offline_sync_status(database_path:String)->Result<Value,String>{
 let db=Connection::open(database_path).map_err(|_|"invalid_database_file")?;
 let (workspace,address,base,last):(String,String,i64,Option<String>)=db.query_row("SELECT workspace_id,server_address,base_revision,last_sync_at FROM sync_workspace LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"offline_workspace_missing")?;
 let pending:i64=db.query_row("SELECT COUNT(*) FROM sync_outbox WHERE synced_at IS NULL",[],|r|r.get(0)).map_err(|_|"sync_failed")?;
 Ok(json!({"workspaceId":workspace,"serverAddress":address,"baseRevision":base,"lastSyncAt":last,"pending":pending}))
}

#[tauri::command]
pub(crate) async fn sync_offline_database(app:AppHandle,database_path:String,server_token:String)->Result<Value,String>{
 let status=get_offline_sync_status(database_path.clone())?;let workspace=status["workspaceId"].as_str().ok_or("offline_workspace_missing")?;let address=status["serverAddress"].as_str().ok_or("offline_workspace_missing")?;let base=status["baseRevision"].as_i64().unwrap_or(0);let pending=status["pending"].as_i64().unwrap_or(0);
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|_|"connection_failed")?;
 let me:Value=client.get(endpoint(address,"/api/v1/auth/me")?).bearer_auth(&server_token).send().await.map_err(|_|"connection_failed")?.error_for_status().map_err(|_|"authentication_required")?.json().await.map_err(|_|"api_incompatible")?;
 if me["organization"]["id"].as_str()!=Some(workspace){return Err("workspace_mismatch".into())}
 let remote:Value=client.get(endpoint(address,"/api/v1/snapshot/status")?).bearer_auth(&server_token).send().await.map_err(|_|"connection_failed")?.error_for_status().map_err(|_|"sync_failed")?.json().await.map_err(|_|"api_incompatible")?;let remote_revision=remote["revision"].as_i64().ok_or("api_incompatible")?;
 if pending>0&&remote_revision!=base{return Err("sync_conflict".into())}
 if pending==0&&remote_revision>base{
  let username=me["user"]["username"].as_str().ok_or("api_incompatible")?;let existing=current_offline_user(&Connection::open(&database_path).map_err(|_|"invalid_database_file")?,username)?;
  let response=client.get(endpoint(address,"/api/v1/snapshot")?).bearer_auth(&server_token).send().await.map_err(|_|"connection_failed")?.error_for_status().map_err(|_|"snapshot_failed")?;if response.headers().get("x-workspace-id").and_then(|v|v.to_str().ok())!=Some(workspace){return Err("workspace_mismatch".into())}let bytes=response.bytes().await.map_err(|_|"snapshot_failed")?;
  let temp=app.path().app_cache_dir().map_err(|_|"snapshot_failed")?.join(format!("sync-{}.sqlite",Uuid::new_v4()));if let Some(parent)=temp.parent(){fs::create_dir_all(parent).map_err(|_|"snapshot_failed")?}fs::write(&temp,bytes).map_err(|_|"snapshot_failed")?;let copied=sqlite_backup(&temp,std::path::Path::new(&database_path));let _=fs::remove_file(&temp);copied?;
  let db=Connection::open(&database_path).map_err(|_|"invalid_database_file")?;db.execute_batch("CREATE TABLE IF NOT EXISTS sync_workspace(workspace_id TEXT PRIMARY KEY,server_address TEXT NOT NULL,base_revision INTEGER NOT NULL DEFAULT 0,last_sync_at TEXT,device_id TEXT NOT NULL);").map_err(|_|"sync_failed")?;db.execute("DELETE FROM admin_users WHERE username=?1 COLLATE NOCASE AND id<>?2",params![existing.values[6],existing.values[0]]).map_err(|_|"sync_failed")?;db.execute("INSERT OR REPLACE INTO admin_users(id,first_name,last_name,phone_number,password_hash,role,username,permissions_json,active,revision,auth_version,is_owner,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![existing.values[0],existing.values[1],existing.values[2],existing.values[3],existing.values[4],existing.values[5],existing.values[6],existing.values[7],existing.active,existing.revision,existing.auth_version,existing.is_owner,existing.deleted]).map_err(|_|"sync_failed")?;db.execute("INSERT OR REPLACE INTO sync_workspace(workspace_id,server_address,base_revision,last_sync_at,device_id) VALUES(?1,?2,?3,CURRENT_TIMESTAMP,COALESCE((SELECT device_id FROM sync_workspace WHERE workspace_id=?1),?4))",params![workspace,address,remote_revision,Uuid::new_v4().to_string()]).map_err(|_|"sync_failed")?;db.execute("UPDATE sync_outbox SET synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP)",[]).map_err(|_|"sync_failed")?;
  return Ok(json!({"direction":"download","revision":remote_revision,"pending":0}))
 }
 if pending>0{
  if me["user"]["role"]!="super_admin"{return Err("permission_denied".into())}
  let temp=app.path().app_cache_dir().map_err(|_|"snapshot_failed")?.join(format!("upload-{}.sqlite",Uuid::new_v4()));if let Some(parent)=temp.parent(){fs::create_dir_all(parent).map_err(|_|"snapshot_failed")?}sqlite_backup(std::path::Path::new(&database_path),&temp)?;let bytes=fs::read(&temp).map_err(|_|"snapshot_failed")?;let _=fs::remove_file(&temp);let sync_id=Uuid::new_v4().to_string();
  let response=client.put(endpoint(address,"/api/v1/snapshot")?).bearer_auth(&server_token).header("Content-Type","application/octet-stream").header("X-Workspace-Id",workspace).header("X-Base-Revision",base).header("X-Sync-Id",sync_id).body(bytes).send().await.map_err(|_|"connection_failed")?;if response.status()==reqwest::StatusCode::CONFLICT{return Err("sync_conflict".into())}let response=response.error_for_status().map_err(|error|if error.status()==Some(reqwest::StatusCode::FORBIDDEN){"permission_denied"}else{"sync_failed"})?;let body:Value=response.json().await.map_err(|_|"api_incompatible")?;let revision=body["revision"].as_i64().ok_or("api_incompatible")?;let db=Connection::open(&database_path).map_err(|_|"invalid_database_file")?;db.execute("UPDATE sync_outbox SET synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP)",[]).map_err(|_|"sync_failed")?;db.execute("UPDATE sync_workspace SET base_revision=?1,last_sync_at=CURRENT_TIMESTAMP WHERE workspace_id=?2",params![revision,workspace]).map_err(|_|"sync_failed")?;db.execute("UPDATE api_state SET revision=?1 WHERE id=1",[revision]).map_err(|_|"sync_failed")?;return Ok(json!({"direction":"upload","revision":revision,"pending":0}))
 }
 Ok(json!({"direction":"none","revision":remote_revision,"pending":0}))
}
