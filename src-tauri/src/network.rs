use super::*;
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Write},process::{Child,Command,Stdio},sync::Mutex};

struct OwnedServer {child:Child,host:String,port:u16,organization_id:String}
static SERVER:Mutex<Option<OwnedServer>>=Mutex::new(None);

fn api_directory(app:&AppHandle)->Result<PathBuf,String> {
    let development=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("server");
    let directory=std::env::var_os("SPICE_API_DIR").map(PathBuf::from).unwrap_or(development);
    if directory.join("src/server.js").is_file() {return Ok(directory);}
    let resources=app.path().resource_dir().map_err(|_|"server_runtime_unavailable")?.join("server");
    if resources.join("src/server.js").is_file() {Ok(resources)}else{Err("server_runtime_unavailable".into())}
}
fn hidden(command:&mut Command) {
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    #[cfg(not(windows))] {let _=command;}
}
#[tauri::command]
pub(crate) fn get_network_status(app:AppHandle)->Result<Value,String> {
    let directory=api_directory(&app)?;
    let mut command=Command::new("node");command.current_dir(&directory).arg("src/control.js");hidden(&mut command);
    let output=command.output().map_err(|_|"server_runtime_unavailable")?;
    if !output.status.success() {return Err("server_runtime_unavailable".into());}
    let mut info:Value=serde_json::from_slice(&output.stdout).map_err(|_|"server_runtime_unavailable")?;
    let mut server=SERVER.lock().map_err(|_|"server_unavailable")?;
    if server.as_mut().is_some_and(|s|s.child.try_wait().ok().flatten().is_some()) {*server=None;}
    info["running"]=json!(server.is_some());
    if let Some(owned)=server.as_ref() {info["host"]=json!(owned.host);info["port"]=json!(owned.port);info["address"]=json!(format!("http://{}:{}",owned.host,owned.port));}
    Ok(info)
}
#[tauri::command]
pub(crate) async fn start_network_server(app:AppHandle,database_path:String,identifier:String,password:String,host:String,port:u16)->Result<Value,String> {
    // Starting a listener requires the existing local database administrator's password.
    let identity=authenticate_database(Path::new(&database_path),&identifier,&password)?;
    let owner=identity.user.as_ref().filter(|user|user["role"]=="super_admin").ok_or("permission_denied")?;
    if port==0 {return Err("invalid_server_port".into());}
    let info=get_network_status(app.clone())?;
    if !info["addresses"].as_array().is_some_and(|entries|entries.iter().any(|entry|entry["address"].as_str()==Some(&host))) {return Err("invalid_network_interface".into());}
    let connection=open_product_database(&database_path)?;
    let (first_name,last_name,mut phone):(String,String,String)=connection.query_row("SELECT first_name,last_name,phone_number FROM admin_users WHERE id=?1",[owner["id"].as_str().ok_or("invalid_credentials")?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"invalid_credentials")?;
    if phone.starts_with("local:"){phone=owner["username"].as_str().ok_or("invalid_credentials")?.to_owned()}
    let (organization_key,company_name):(String,String)=connection.query_row("SELECT id,company_name FROM company_info LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"invalid_database_file")?;
    let directory=api_directory(&app)?;
    let mut command=Command::new("node");
    command.current_dir(directory).arg("src/server.js").arg("--desktop-server")
        .env("API_HOST",&host).env("PORT",port.to_string()).env("LAN_ENABLED","true").env("SERVER_MODE","lan")
        .env("DATABASE_WORKER",std::env::current_exe().map_err(|_|"server_runtime_unavailable")?)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());hidden(&mut command);
    let mut server=SERVER.lock().map_err(|_|"server_unavailable")?;
    if server.is_some() {return Err("server_already_running".into());}
    let mut child=command.spawn().map_err(|_|"server_runtime_unavailable")?;
    let bootstrap=json!({"databasePath":database_path,"organizationKey":organization_key,"companyName":company_name,"firstName":first_name,"lastName":last_name,"phone":phone,"password":password});
    let sent=child.stdin.take().ok_or("server_start_failed").and_then(|mut stdin|writeln!(stdin,"{bootstrap}").map_err(|_|"server_start_failed"));
    if sent.is_err() {let _=child.kill();return Err("server_start_failed".into());}
    let stdout=child.stdout.take().ok_or("server_start_failed")?;
    let (sender,receiver)=std::sync::mpsc::channel();
    std::thread::spawn(move||{for line in BufReader::new(stdout).lines().map_while(Result::ok) {if let Ok(value)=serde_json::from_str::<Value>(&line) {let _=sender.send(value);}}});
    match receiver.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(result) if result["ready"]==true=>{let organization_id=result["organizationId"].as_str().unwrap_or("").to_owned();*server=Some(OwnedServer{child,host,port,organization_id});Ok(result)},
        _=>{let _=child.kill();let _=child.wait();Err("server_start_failed".into())}
    }
}
pub(crate) fn stop_owned_server() {if let Ok(mut server)=SERVER.lock() {if let Some(mut owned)=server.take() {let _=owned.child.kill();let _=owned.child.wait();}}}
#[tauri::command]
pub(crate) async fn stop_network_server(window:tauri::WebviewWindow,server_token:Option<String>)->Result<(),String> {
    if let Some(token)=server_token {
        let owned=SERVER.lock().map_err(|_|"server_unavailable")?.as_ref().map(|s|(s.host.clone(),s.port,s.organization_id.clone())).ok_or("server_unavailable")?;
        let response=reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|_|"server_unavailable")?
            .get(format!("http://{}:{}/api/v1/auth/me",owned.0,owned.1)).bearer_auth(token).send().await.map_err(|_|"server_unavailable")?;
        if !response.status().is_success(){return Err("permission_denied".into())}
        let account:Value=response.json().await.map_err(|_|"permission_denied")?;
        if owned.2.is_empty()||account["organization"]["id"]!=owned.2||!local_users::permits(&account["user"],"settings","edit"){return Err("permission_denied".into())}
        let mut server=SERVER.lock().map_err(|_|"server_unavailable")?;
        if !server.as_ref().is_some_and(|s|s.host==owned.0&&s.port==owned.1&&s.organization_id==owned.2){return Err("server_unavailable".into())}
        if let Some(mut owned)=server.take(){let _=owned.child.kill();let _=owned.child.wait();}
    }else{local_users::authorize(window.label(),"stop_network_server",&json!({}))?;stop_owned_server();}
    Ok(())
}
