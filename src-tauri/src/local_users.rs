//! Local identities stay in the existing SQLite admin_users table, never in sync.
use super::*;
use serde_json::{json,Value};
use std::sync::{Mutex,OnceLock};
use unicode_normalization::UnicodeNormalization;

fn policy()->&'static Value {static POLICY:OnceLock<Value>=OnceLock::new();POLICY.get_or_init(||serde_json::from_str(include_str!("../../src/shared/permission-config.json")).expect("permission policy"))}
#[derive(Clone)]
struct Session {path:PathBuf,id:String,version:i64}
static SESSIONS:Mutex<Option<HashMap<String,Session>>>=Mutex::new(None);
fn path(value:&str)->Result<PathBuf,String>{fs::canonicalize(value).map_err(|_|"invalid_database_file".into())}
fn connection(value:&str)->Result<Connection,String>{
    let db=Connection::open(path(value)?).map_err(|_|"invalid_database_file")?;
    db.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e|e.to_string())?;Ok(db)
}
pub(crate) fn ensure_schema(db:&mut Connection)->Result<(),String>{
    let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let columns:Vec<String>=tx.prepare("PRAGMA table_info(admin_users)").map_err(|e|e.to_string())?.query_map([],|r|r.get(1)).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    if columns.is_empty(){return Err("invalid_database_file".into())}
    let legacy=!columns.iter().any(|c|c=="auth_version");
    for (name,definition) in [("username","TEXT COLLATE NOCASE"),("active","INTEGER NOT NULL DEFAULT 1"),("permissions_json","TEXT NOT NULL DEFAULT '{}'"),("revision","INTEGER NOT NULL DEFAULT 1"),("auth_version","INTEGER NOT NULL DEFAULT 0"),("deleted_at","TEXT"),("is_owner","INTEGER NOT NULL DEFAULT 0")]{
        if !columns.iter().any(|c|c==name){tx.execute_batch(&format!("ALTER TABLE admin_users ADD COLUMN {name} {definition}")).map_err(|e|e.to_string())?;}
    }
    if legacy {
        // Only the original legacy administrator is promoted, once. Ordinary
        // users are never promoted when another owner is disabled/deleted.
        tx.execute("UPDATE admin_users SET role='super_admin' WHERE id=(SELECT id FROM admin_users ORDER BY created_at,rowid LIMIT 1) AND role='admin'",[]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE admin_users SET username=lower(phone_number) WHERE username IS NULL",[]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE admin_users SET is_owner=1 WHERE id=(SELECT id FROM admin_users ORDER BY created_at,rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM admin_users WHERE is_owner=1)",[]).map_err(|e|e.to_string())?;
    tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS local_username_unique ON admin_users(username COLLATE NOCASE) WHERE deleted_at IS NULL;").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
struct Account {user:Value,hash:String,version:i64}
fn account(row:&rusqlite::Row<'_>)->rusqlite::Result<Account>{
    let first:String=row.get(1)?;let last:String=row.get(2)?;let raw:String=row.get(8)?;
    Ok(Account{user:json!({"id":row.get::<_,String>(0)?,"fullName":format!("{first} {last}").trim(),"username":row.get::<_,Option<String>>(6)?.unwrap_or_default(),"phone":row.get::<_,String>(3)?,"role":row.get::<_,String>(5)?,"active":row.get::<_,i64>(7)?!=0,"permissions":serde_json::from_str::<Value>(&raw).unwrap_or(json!({})),"revision":row.get::<_,i64>(9)?,"isOwner":row.get::<_,i64>(11)?!=0}),hash:row.get(4)?,version:row.get(10)?})
}
const SELECT:&str="SELECT id,first_name,last_name,phone_number,password_hash,role,username,active,permissions_json,revision,auth_version,is_owner FROM admin_users";
fn by_id(db:&Connection,id:&str)->Result<Account,String>{db.query_row(&format!("{SELECT} WHERE id=?1 AND deleted_at IS NULL"),[id],account).map_err(|_|"user_not_found".into())}
pub(crate) fn authenticate(database:&str,identifier:&str,password:&str)->Result<Value,String>{
    let mut db=connection(database)?;ensure_schema(&mut db)?;
    let named=db.query_row(&format!("{SELECT} WHERE username=?1 COLLATE NOCASE AND deleted_at IS NULL"),[identifier.trim()],account).optional().map_err(|e|e.to_string())?;
    let found=if let Some(user)=named{user}else{
        let mut stmt=db.prepare(&format!("{SELECT} WHERE (phone_number=?1 OR trim(first_name || ' ' || last_name)=?1) AND deleted_at IS NULL LIMIT 2")).map_err(|e|e.to_string())?;
        let mut found=stmt.query_map([identifier.trim()],account).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        if found.len()!=1{return Err("invalid_credentials".into())}found.remove(0)
    };
    if found.user["active"]!=true||Argon2::default().verify_password(password.as_bytes(),&PasswordHash::new(&found.hash).map_err(|_|"invalid_credentials")?).is_err(){return Err("invalid_credentials".into())}
    Ok(found.user)
}
pub(crate) fn permits(user:&Value,module:&str,action:&str)->bool{
    if user["active"]!=true{return false}
    if user["role"]=="super_admin"{return true}
    let role=if user["role"]=="member"{"viewer"}else{user["role"].as_str().unwrap_or("")};
    user["permissions"][module][action].as_bool().unwrap_or_else(||policy()["rolePermissions"][role][module][action].as_bool().unwrap_or(false))
}
fn require(user:&Value,module:&str,action:&str)->Result<(),String>{if permits(user,module,action){Ok(())}else{Err("permission_denied".into())}}
pub(crate) fn bind(window:&str,database:&str,user:&Value)->Result<(),String>{
    let db=connection(database)?;let current=by_id(&db,user["id"].as_str().ok_or("invalid_credentials")?)?;
    SESSIONS.lock().map_err(|_|"authentication_required")?.get_or_insert_with(HashMap::new).insert(window.into(),Session{path:path(database)?,id:current.user["id"].as_str().unwrap().into(),version:current.version});Ok(())
}
pub(crate) fn clear(window:&str){if let Ok(mut map)=SESSIONS.lock(){if let Some(map)=map.as_mut(){map.remove(window);}}}
fn current(window:&str,database:&str)->Result<Value,String>{
    let saved=SESSIONS.lock().map_err(|_|"authentication_required")?.as_ref().and_then(|map|map.get(window)).cloned().ok_or("authentication_required")?;
    if saved.path!=path(database)?{return Err("authentication_required".into())}
    let account=by_id(&connection(database)?,&saved.id).map_err(|_|"authentication_required")?;
    if account.version!=saved.version||account.user["active"]!=true{return Err("authentication_required".into())}Ok(account.user)
}
fn manager(window:&str,database:&str,_action:&str)->Result<Value,String>{let user=current(window,database)?;if user["isOwner"]==true{Ok(user)}else{Err("permission_denied".into())}}
#[tauri::command]
pub(crate) fn clear_local_session(window:tauri::WebviewWindow){clear(window.label())}
#[tauri::command]
pub(crate) fn get_local_current_user(window:tauri::WebviewWindow,database_path:String)->Result<Value,String>{current(window.label(),&database_path)}
#[tauri::command]
pub(crate) fn list_local_users(window:tauri::WebviewWindow,database_path:String)->Result<Value,String>{list(window.label(),&database_path)}
fn list(window:&str,database:&str)->Result<Value,String>{
    manager(window,database,"view")?;let db=connection(database)?;
    let users=db.prepare(&format!("{SELECT} WHERE deleted_at IS NULL ORDER BY created_at,rowid")).map_err(|e|e.to_string())?.query_map([],|r|Ok(account(r)?.user)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"users":users}))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct UserInput {full_name:String,username:String,role:String,active:bool,#[serde(default)] permissions:Value,password:Option<String>,revision:Option<i64>}
fn validate(input:&UserInput,actor:&Value,create:bool)->Result<(),String>{
    let name=input.full_name.trim();let username=input.username.trim();let mut names=name.split_whitespace();
    if name.is_empty()||name.chars().count()>200||names.next().unwrap_or("").chars().count()>100||names.collect::<Vec<_>>().join(" ").chars().count()>100
        ||username.chars().count()<2||username.chars().count()>80||!(username.chars().all(|c|c.is_alphanumeric()||c=='_'||c==' ')||(username.starts_with('+')&&username[1..].chars().all(|c|c.is_ascii_digit())))
        ||!policy()["roles"].as_array().unwrap().iter().any(|role|role==&input.role)
        ||(create&&input.password.is_none())||input.password.as_ref().is_some_and(|p|p.chars().count()<4||p.chars().count()>128){return Err("invalid_request".into())}
    let Some(overrides)=input.permissions.as_object()else{return Err("invalid_request".into())};
    for (module,values) in overrides {
        if !policy()["modules"].as_array().unwrap().iter().any(|m|m==module){return Err("invalid_request".into())}
        let Some(values)=values.as_object()else{return Err("invalid_request".into())};
        for (action,value) in values{if !value.is_boolean()||!(policy()["actions"].as_array().unwrap().iter().any(|a|a==action)||module=="users"&&action=="manage"){return Err("invalid_request".into())}}
    }
    let proposed=json!({"role":input.role,"active":true,"permissions":input.permissions});
    if actor["role"]!="super_admin" {
        if input.role=="super_admin"{return Err("permission_denied".into())}
        for module in policy()["modules"].as_array().unwrap(){for action in ["view","create","edit","delete","print","manage"] {
            if permits(&proposed,module.as_str().unwrap(),action)&&!permits(actor,module.as_str().unwrap(),action){return Err("permission_denied".into())}
        }}
    }Ok(())
}
fn storage_error(e:rusqlite::Error)->String {if e.sqlite_error_code()==Some(rusqlite::ErrorCode::ConstraintViolation){"username_exists".into()}else{e.to_string()}}
fn protect_owner(db:&Connection,actor:&Value,target:&Value,still_owner:bool)->Result<(),String>{
    if target["isOwner"]==true&&!still_owner{return Err("last_super_admin".into())}
    if target["role"]=="super_admin" {
        if actor["role"]!="super_admin"{return Err("permission_denied".into())}
        let count:i64=db.query_row("SELECT count(*) FROM admin_users WHERE role='super_admin' AND active=1 AND deleted_at IS NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if target["active"]==true&&!still_owner&&count<=1{return Err("last_super_admin".into())}
    }Ok(())
}
#[tauri::command]
pub(crate) fn save_local_user(window:tauri::WebviewWindow,database_path:String,id:Option<String>,payload:UserInput)->Result<Value,String>{save(window.label(),&database_path,id.as_deref(),payload)}
fn save(window:&str,database:&str,id:Option<&str>,input:UserInput)->Result<Value,String>{
    if id.is_some()!=input.revision.is_some(){return Err("invalid_request".into())}
    let actor=manager(window,database,if id.is_some(){"edit"}else{"create"})?;validate(&input,&actor,id.is_none())?;
    let hash=input.password.as_ref().map(|password|{
        let salt=SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|e|e.to_string())?;
        Argon2::default().hash_password(password.as_bytes(),&salt).map(|v|v.to_string()).map_err(|e|e.to_string())
    }).transpose()?;
    let mut db=connection(database)?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    // Re-read inside the same write transaction; ownership changes cannot win a race.
    let actor=current(window,database)?;if actor["isOwner"]!=true{return Err("permission_denied".into())}validate(&input,&actor,id.is_none())?;
    let id=id.map(str::to_owned).unwrap_or_else(||Uuid::new_v4().to_string());
    let name=input.full_name.split_whitespace().collect::<Vec<_>>();let first=name[0];let last=name[1..].join(" ");let username=input.username.trim().split_whitespace().collect::<Vec<_>>().join(" ").nfc().collect::<String>().to_lowercase();
    let collision:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM admin_users WHERE deleted_at IS NULL AND id<>?1 AND (username=?2 COLLATE NOCASE OR phone_number=?2 COLLATE NOCASE))",params![id,username],|r|r.get(0)).map_err(|e|e.to_string())?;
    if collision{return Err("username_exists".into())}
    let permissions=serde_json::to_string(&input.permissions).map_err(|_|"invalid_request")?;
    if let Some(revision)=input.revision {
        let target=by_id(&tx,&id)?;
        if target.user["revision"]!=revision{return Err("revision_conflict".into())}
        protect_owner(&tx,&actor,&target.user,input.role=="super_admin"&&input.active)?;
        let proposed=json!({"role":input.role,"active":input.active,"permissions":input.permissions});
        let permission_changed=policy()["modules"].as_array().unwrap().iter().any(|m|["view","create","edit","delete","print","manage"].iter().any(|a|permits(&target.user,m.as_str().unwrap(),a)!=permits(&proposed,m.as_str().unwrap(),a)));
        let access_changed=hash.is_some()||target.user["role"]!=input.role||target.user["active"]!=input.active||permission_changed;
        tx.execute("UPDATE admin_users SET first_name=?1,last_name=?2,username=?3,role=?4,active=?5,permissions_json=?6,password_hash=COALESCE(?7,password_hash),revision=revision+1,auth_version=auth_version+?8 WHERE id=?9",params![first,last,username,input.role,input.active,permissions,hash,i64::from(access_changed),id]).map_err(storage_error)?;
    }else{
        if hash.is_none(){return Err("invalid_request".into())}
        tx.execute("INSERT INTO admin_users(id,first_name,last_name,phone_number,password_hash,role,username,active,permissions_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,first,last,format!("local:{id}"),hash,input.role,username,input.active,permissions]).map_err(storage_error)?;
    }
    let user=by_id(&tx,&id)?.user;tx.commit().map_err(|e|e.to_string())?;Ok(json!({"user":user}))
}
#[tauri::command]
pub(crate) fn delete_local_user(window:tauri::WebviewWindow,database_path:String,id:String,revision:i64)->Result<Value,String>{remove(window.label(),&database_path,&id,revision)}
fn remove(window:&str,database:&str,id:&str,revision:i64)->Result<Value,String>{
    manager(window,database,"delete")?;let mut db=connection(database)?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let actor=current(window,database)?;if actor["isOwner"]!=true{return Err("permission_denied".into())}
    let target=by_id(&tx,id)?.user;if target["revision"]!=revision{return Err("revision_conflict".into())}protect_owner(&tx,&actor,&target,false)?;
    tx.execute("UPDATE admin_users SET deleted_at=CURRENT_TIMESTAMP,active=0,revision=revision+1,auth_version=auth_version+1 WHERE id=?1",[id]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(json!({"deleted":true}))
}

// This boundary protects direct Tauri calls as well as normal UI actions. The
// trusted Express database worker keeps its existing central authorization.
pub(crate) fn authorize(window:&str,command:&str,args:&Value)->Result<(),String>{
    if matches!(command,"create_local_database_command"|"authenticate_local_database"|"list_local_databases"|"register_existing_database"|"clear_local_session"|"get_network_status"|"get_local_storage_context"|"get_license_status"|"activate_license"){return Ok(())}
    if command=="initialize_offline_database"&&args["serverToken"].is_string(){return Ok(())}
    // Remote stop is authenticated against the owned server inside the command.
    if command=="stop_network_server"&&args["serverToken"].is_string(){return Ok(())}
    if command.starts_with("plugin:"){return Ok(())}
    let database=args["databasePath"].as_str().or_else(||args["payload"]["databasePath"].as_str());
    if let (Some(top),Some(nested))=(args["databasePath"].as_str(),args["payload"]["databasePath"].as_str()){
        if path(top)?!=path(nested)?{return Err("permission_denied".into())}
    }
    let owned;
    let database=if let Some(database)=database {database}else{
        owned=SESSIONS.lock().map_err(|_|"authentication_required")?.as_ref().and_then(|m|m.get(window)).map(|s|s.path.to_string_lossy().into_owned()).ok_or("authentication_required")?;&owned
    };
    let user=current(window,database)?;
    match command {
        "get_local_current_user"=>Ok(()),
        "list_local_users"=>manager(window,database,"view").map(|_|()),
        "save_local_user"=>manager(window,database,if args["id"].is_string(){"edit"}else{"create"}).map(|_|()),
        "delete_local_user"=>manager(window,database,"delete").map(|_|()),
        "get_network_status"=>require(&user,"settings","view"),
        "start_network_server"|"stop_network_server"|"sign_in_to_api"|"get_pending_sync_events"|"mark_sync_events_completed"|"backup_local_database"|"restore_local_database"|"sync_offline_database"=>require(&user,"settings","edit"),
        "get_offline_sync_status"=>require(&user,"settings","view"),
        "save_excel_export"=>if policy()["modules"].as_array().unwrap().iter().any(|m|permits(&user,m.as_str().unwrap(),"print")){Ok(())}else{Err("permission_denied".into())},
        "get_cash_register"=>if ["expenses","withdrawals","cash_register"].iter().any(|m|permits(&user,m,"view")){Ok(())}else{Err("permission_denied".into())},
        "save_cash_document"=>require(&user,document_module(args["payload"]["kind"].as_str().unwrap_or("")),if args["payload"]["expectedRevision"].is_null(){"create"}else{"edit"}),
        "delete_cash_document"|"get_cash_document_history"=>{
            let db=connection(database)?;let kind:String=db.query_row("SELECT kind FROM cash_documents WHERE id=?1 AND deleted_at IS NULL",[args["id"].as_str().unwrap_or("")],|r|r.get(0)).map_err(|_|"document_not_found")?;
            require(&user,document_module(&kind),if command=="delete_cash_document"{"delete"}else{"view"})
        },
        "list_pharmaceutical_companies" if permits(&user,"products","view")=>Ok(()),
        "list_expiry_alerts" if permits(&user,"settings","view")=>Ok(()),
        _=>{
            let access=&policy()["commandAccess"][command];
            if !policy()["commandAccess"].as_object().unwrap().contains_key(command){return Err("permission_denied".into())}
            if access.is_null(){Ok(())}else{require(&user,access[0].as_str().unwrap(),access[1].as_str().unwrap())}
        }
    }
}
fn document_module(kind:&str)->&str{match kind{"WITHDRAWAL"=>"withdrawals","DEPOSIT"=>"cash_register",_=>"expenses"}}

pub(crate) fn cash_snapshot(window:&str,database_path:String)->Result<Value,String>{
    let user=current(window,&database_path)?;
    authorize(window,"get_cash_register",&json!({"databasePath":database_path}))?;
    let mut result=cash::get_cash_register(database_path)?;
    if let Some(documents)=result["documents"].as_array_mut(){documents.retain(|d|permits(&user,document_module(d["kind"].as_str().unwrap_or("")),"view"))}
    if !permits(&user,"cash_register","view"){result["transactions"]=json!([])}
    Ok(result)
}

#[tauri::command]
pub(crate) fn get_dashboard_data(window:tauri::WebviewWindow,database_path:String)->Result<Value,String>{
    let user=current(window.label(),&database_path)?;require(&user,"dashboard","view")?;
    // Keep the existing local analytics calculations. A dashboard-only reader
    // receives the numeric snapshot without contact details, labels or notes.
    let mut data=reports::get_reports_data(database_path)?;
    if !permits(&user,"reports","view"){redact_dashboard(&mut data)}
    Ok(data)
}
fn redact_dashboard(data:&mut Value){
    if let Some(sections)=data.as_object_mut(){for (_,value) in sections {if let Some(rows)=value.as_array_mut(){for row in rows {if let Some(record)=row.as_object_mut(){
        record.retain(|key,_|!matches!(key.as_str(),"name"|"medicine_name"|"customer_name"|"company_name"|"phone"|"customer_phone"|"office_phone"|"address"|"company_address"|"country"|"notes"|"invoice_number"|"barcode"|"manufacturer"|"formula"|"title"|"person"));
    }}}}}
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {database:String,window:String,owner:Value,folder:PathBuf}
    impl Drop for Fixture {fn drop(&mut self){clear(&self.window);let _=fs::remove_dir_all(&self.folder);}}
    fn fixture()->Fixture{
        let folder=std::env::temp_dir().join(format!("spice-local-users-{}",Uuid::new_v4()));fs::create_dir_all(&folder).unwrap();
        let database=folder.join("local.sqlite3").to_string_lossy().into_owned();let db=Connection::open(&database).unwrap();
        db.execute_batch("CREATE TABLE admin_users(id TEXT PRIMARY KEY,first_name TEXT NOT NULL,last_name TEXT NOT NULL,phone_number TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT DEFAULT 'admin',created_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE business_marker(value TEXT);INSERT INTO business_marker VALUES('unchanged');").unwrap();
        let hash=Argon2::default().hash_password(b"1234",&SaltString::encode_b64(b"test-local-salt").unwrap()).unwrap().to_string();
        db.execute("INSERT INTO admin_users(id,first_name,last_name,phone_number,password_hash,role) VALUES('original','First','Owner','+93700112233',?1,'admin'),('legacy-normal','Old','Viewer','+93700445566',?1,'viewer')",[&hash]).unwrap();drop(db);
        let owner=authenticate(&database,"+93700112233","1234").unwrap();let window=Uuid::new_v4().to_string();bind(&window,&database,&owner).unwrap();Fixture{database,window,owner,folder}
    }
    fn input(name:&str,role:&str)->UserInput{UserInput{full_name:name.into(),username:name.to_lowercase().replace(' ',"_"),role:role.into(),active:true,permissions:json!({}),password:Some("test-password-123".into()),revision:None}}
    fn edit(user:&Value)->UserInput{UserInput{full_name:user["fullName"].as_str().unwrap().into(),username:user["username"].as_str().unwrap().into(),role:user["role"].as_str().unwrap().into(),active:user["active"].as_bool().unwrap(),permissions:user["permissions"].clone(),password:None,revision:user["revision"].as_i64()}}
    fn added(f:&Fixture,name:&str,role:&str)->Value{save(&f.window,&f.database,None,input(name,role)).unwrap()["user"].clone()}
    #[test]
    fn legacy_owner_migration_preserves_users_passwords_and_business_rows(){
        let f=fixture();assert_eq!(f.owner["role"],"super_admin");assert_eq!(f.owner["id"],"original");
        let old=authenticate(&f.database,"Old Viewer","1234").unwrap();assert_eq!(old["role"],"viewer");
        assert_eq!(list(&f.window,&f.database).unwrap()["users"].as_array().unwrap().len(),2);
        assert_eq!(connection(&f.database).unwrap().query_row("SELECT value FROM business_marker",[],|r|r.get::<_,String>(0)).unwrap(),"unchanged");
        let before=connection(&f.database).unwrap().query_row("SELECT password_hash FROM admin_users WHERE id='original'",[],|r|r.get::<_,String>(0)).unwrap();
        let mut db=connection(&f.database).unwrap();ensure_schema(&mut db).unwrap();assert_eq!(db.query_row("SELECT password_hash FROM admin_users WHERE id='original'",[],|r|r.get::<_,String>(0)).unwrap(),before);
        assert!(!serde_json::to_string(&f.owner).unwrap().contains("argon2"));
    }
    #[test]
    fn local_user_crud_and_login_persist_after_session_restart(){
        let f=fixture();let user=added(&f,"Offline User","viewer");let id=user["id"].as_str().unwrap();
        assert_eq!(authenticate(&f.database,"OFFLINE_USER","test-password-123").unwrap()["id"],id);
        let mut update=edit(&user);update.full_name="Renamed User".into();update.permissions=json!({"products":{"create":true,"delete":false}});
        let updated=save(&f.window,&f.database,Some(id),update).unwrap()["user"].clone();assert_eq!(updated["revision"],2);
        assert!(permits(&updated,"products","create"));assert!(!permits(&updated,"products","delete"));
        assert_eq!(save(&f.window,&f.database,Some(id),edit(&user)).unwrap_err(),"revision_conflict");
        let mut inactive=edit(&updated);inactive.active=false;let disabled=save(&f.window,&f.database,Some(id),inactive).unwrap()["user"].clone();
        assert_eq!(authenticate(&f.database,"offline_user","test-password-123").unwrap_err(),"invalid_credentials");
        let mut active=edit(&disabled);active.active=true;let active=save(&f.window,&f.database,Some(id),active).unwrap()["user"].clone();
        clear(&f.window);let owner=authenticate(&f.database,"First Owner","1234").unwrap();bind(&f.window,&f.database,&owner).unwrap();
        assert_eq!(list(&f.window,&f.database).unwrap()["users"].as_array().unwrap().len(),3);
        remove(&f.window,&f.database,id,active["revision"].as_i64().unwrap()).unwrap();assert!(authenticate(&f.database,"offline_user","test-password-123").is_err());
        assert_eq!(connection(&f.database).unwrap().query_row("SELECT count(*) FROM admin_users WHERE id=?1",[id],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn direct_commands_reject_unauthorized_users_and_database_path_smuggling(){
        let f=fixture();let user=added(&f,"Restricted User","viewer");bind(&f.window,&f.database,&user).unwrap();
        let args=json!({"databasePath":f.database});assert!(authorize(&f.window,"list_medicines",&args).is_ok());
        for command in ["create_medicine","create_purchase","delete_sale","list_local_users","save_local_user","delete_local_user","get_reports_data"]{assert_eq!(authorize(&f.window,command,&args).unwrap_err(),"permission_denied", "{command}")}
        assert_eq!(save(&f.window,&f.database,None,input("Forged Admin","super_admin")).unwrap_err(),"permission_denied");
        assert_eq!(remove(&f.window,&f.database,"original",1).unwrap_err(),"permission_denied");
        let other=fixture();assert_eq!(authorize(&f.window,"list_medicines",&json!({"databasePath":other.database})).unwrap_err(),"authentication_required");
        assert_eq!(authorize(&f.window,"create_medicine",&json!({"databasePath":f.database,"payload":{"databasePath":other.database}})).unwrap_err(),"permission_denied");
        clear(&f.window);assert_eq!(authorize(&f.window,"list_medicines",&args).unwrap_err(),"authentication_required");
    }
    #[test]
    fn only_original_owner_is_promoted_and_delegates_cannot_escalate(){
        let f=fixture();let mut db=connection(&f.database).unwrap();db.execute("UPDATE admin_users SET active=0 WHERE id='original'",[]).unwrap();ensure_schema(&mut db).unwrap();
        assert_eq!(by_id(&db,"legacy-normal").unwrap().user["role"],"viewer");db.execute("UPDATE admin_users SET active=1 WHERE id='original'",[]).unwrap();drop(db);
        let mut delegated=input("Delegated User","viewer");delegated.permissions=json!({"users":{"manage":true,"view":true,"create":true}});
        let user=save(&f.window,&f.database,None,delegated).unwrap()["user"].clone();bind(&f.window,&f.database,&user).unwrap();
        assert_eq!(list(&f.window,&f.database).unwrap_err(),"permission_denied");assert_eq!(save(&f.window,&f.database,None,input("Unsafe Admin","admin")).unwrap_err(),"permission_denied");
        assert_eq!(save(&f.window,&f.database,None,input("Unsafe Owner","super_admin")).unwrap_err(),"permission_denied");
    }
    #[test]
    fn last_owner_cannot_be_deleted_disabled_or_demoted(){
        let f=fixture();assert_eq!(remove(&f.window,&f.database,"original",1).unwrap_err(),"last_super_admin");
        let mut inactive=edit(&f.owner);inactive.active=false;assert_eq!(save(&f.window,&f.database,Some("original"),inactive).unwrap_err(),"last_super_admin");
        let mut ordinary=edit(&f.owner);ordinary.role="admin".into();assert_eq!(save(&f.window,&f.database,Some("original"),ordinary).unwrap_err(),"last_super_admin");
        let second=added(&f,"Second Owner","super_admin");let second_window=Uuid::new_v4().to_string();bind(&second_window,&f.database,&second).unwrap();
        let mut self_edit=edit(&second);self_edit.active=false;assert_eq!(save(&second_window,&f.database,second["id"].as_str(),self_edit).unwrap_err(),"permission_denied");clear(&second_window);
        assert_eq!(connection(&f.database).unwrap().query_row("SELECT count(*) FROM admin_users WHERE is_owner=1 AND role='super_admin' AND active=1 AND deleted_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn revocation_is_immediate_and_self_reported_identity_cannot_override_it(){
        let f=fixture();let user=added(&f,"Revoked User","viewer");let child=Uuid::new_v4().to_string();bind(&child,&f.database,&user).unwrap();
        let mut updated=edit(&user);updated.permissions=json!({"products":{"view":false}});save(&f.window,&f.database,user["id"].as_str(),updated).unwrap();
        assert_eq!(authorize(&child,"list_medicines",&json!({"databasePath":f.database,"user":{"role":"super_admin"}})).unwrap_err(),"authentication_required");clear(&child);
        let user=authenticate(&f.database,"revoked_user","test-password-123").unwrap();bind(&child,&f.database,&user).unwrap();
        assert_eq!(authorize(&child,"list_medicines",&json!({"databasePath":f.database})).unwrap_err(),"permission_denied");clear(&child);
    }
    #[test]
    fn dashboard_permission_is_separate_from_reports_and_removes_contact_details(){
        let f=fixture();let mut data=input("Dashboard Viewer","viewer");data.permissions=json!({"dashboard":{"view":true},"reports":{"view":false}});
        let user=save(&f.window,&f.database,None,data).unwrap()["user"].clone();bind(&f.window,&f.database,&user).unwrap();
        assert!(authorize(&f.window,"get_dashboard_data",&json!({"databasePath":f.database})).is_ok());
        assert_eq!(authorize(&f.window,"get_reports_data",&json!({"databasePath":f.database})).unwrap_err(),"permission_denied");
        let mut snapshot=json!({"today":"2026-10-22","sales":[{"id":"sale","total":40,"paid_amount":10,"customer_name":"Private","customer_phone":"123","notes":"Private"}]});
        redact_dashboard(&mut snapshot);assert_eq!(snapshot["sales"][0]["total"],40);assert_eq!(snapshot["sales"][0]["paid_amount"],10);assert!(snapshot["sales"][0].get("customer_name").is_none());
    }
    #[test]
    fn validation_and_duplicate_names_never_leave_partial_users(){
        let f=fixture();let before=list(&f.window,&f.database).unwrap()["users"].as_array().unwrap().len();
        for key in ["bad@username","x"]{let mut value=input("Bad User","viewer");value.username=key.into();assert_eq!(save(&f.window,&f.database,None,value).unwrap_err(),"invalid_request")}
        let mut short=input("Bad Password","viewer");short.password=Some("123".into());assert_eq!(save(&f.window,&f.database,None,short).unwrap_err(),"invalid_request");
        let mut bad=input("Bad Permissions","viewer");bad.permissions=json!({"products":{"create":"yes"}});assert_eq!(save(&f.window,&f.database,None,bad).unwrap_err(),"invalid_request");
        added(&f,"Unique User","viewer");assert_eq!(save(&f.window,&f.database,None,input("Unique User","viewer")).unwrap_err(),"username_exists");
        assert_eq!(list(&f.window,&f.database).unwrap()["users"].as_array().unwrap().len(),before+1);
    }
}
