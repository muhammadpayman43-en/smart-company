use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const PUBLIC_KEY: &str = "nwgMgNviEGTLDfLY53OmG5JBUkPUjsKeTE6hFmAQ70M=";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload { device_id: String, issue_date: String, expiry_date: String, license_id: String, exp: u64 }

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored { license: String, activation_date: String, last_seen: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    device_id: String, status: String, activation_date: String, expiry_date: String,
    remaining_days: i64, license_id: String,
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn dir(app: &AppHandle) -> Result<std::path::PathBuf,String> {
    let path=app.path().app_data_dir().map_err(|e|e.to_string())?;
    fs::create_dir_all(&path).map_err(|e|e.to_string())?; Ok(path)
}
fn persistent_id(app:&AppHandle)->Result<String,String>{
    let path=dir(app)?.join("device-id");
    if let Ok(value)=fs::read_to_string(&path){if !value.trim().is_empty(){return Ok(value.trim().into())}}
    let value=Uuid::new_v4().to_string();fs::write(path,&value).map_err(|e|e.to_string())?;Ok(value)
}
fn machine_source(app:&AppHandle)->Result<String,String>{
    #[cfg(target_os="windows")]
    {
        let cpu=std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default();
        let machine=std::process::Command::new("reg").args(["query",r"HKLM\SOFTWARE\Microsoft\Cryptography","/v","MachineGuid"]).output().ok()
            .and_then(|o|String::from_utf8(o.stdout).ok()).unwrap_or_default();
        return Ok(format!("windows|{cpu}|{machine}|{}",persistent_id(app)?));
    }
    #[cfg(target_os="android")]
    { return Ok(format!("android|{}",persistent_id(app)?)); }
    #[cfg(not(any(target_os="windows",target_os="android")))]
    { Ok(format!("device|{}",persistent_id(app)?)) }
}
fn device_id(app:&AppHandle)->Result<String,String>{
    let hash=Sha256::digest(machine_source(app)?.as_bytes());
    let hex=hash[..16].iter().map(|b|format!("{b:02X}")).collect::<String>();
    Ok(format!("{}-{}-{}-{}",&hex[0..8],&hex[8..16],&hex[16..24],&hex[24..32]))
}
fn verify(app:&AppHandle,value:&str)->Result<Payload,String>{
    let (body,sig)=value.trim().split_once('.').ok_or("license_invalid")?;
    let body_bytes=URL_SAFE_NO_PAD.decode(body).map_err(|_|"license_invalid")?;
    let sig_bytes=URL_SAFE_NO_PAD.decode(sig).map_err(|_|"license_invalid")?;
    let key_bytes=base64::engine::general_purpose::STANDARD.decode(PUBLIC_KEY).map_err(|_|"license_invalid")?;
    let key=VerifyingKey::from_bytes(&key_bytes.try_into().map_err(|_|"license_invalid")?).map_err(|_|"license_invalid")?;
    key.verify(&body_bytes,&Signature::from_slice(&sig_bytes).map_err(|_|"license_invalid")?).map_err(|_|"license_invalid")?;
    let payload:Payload=serde_json::from_slice(&body_bytes).map_err(|_|"license_invalid")?;
    if payload.device_id!=device_id(app)? {return Err("license_device_mismatch".into())}
    if payload.exp<=now(){return Err("license_expired".into())}
    Ok(payload)
}
fn empty(app:&AppHandle)->Result<LicenseStatus,String>{Ok(LicenseStatus{device_id:device_id(app)?,status:"not_activated".into(),activation_date:"".into(),expiry_date:"".into(),remaining_days:0,license_id:"".into()})}

#[tauri::command]
pub fn get_license_status(app:AppHandle)->Result<LicenseStatus,String>{
    let path=dir(&app)?.join("license.json");let mut stored:Stored=match fs::read_to_string(&path).ok().and_then(|v|serde_json::from_str(&v).ok()){Some(v)=>v,None=>return empty(&app)};
    let current=now();let payload=match verify(&app,&stored.license){Ok(v)=>v,Err(error)=>{let mut value=empty(&app)?;value.status=if error=="license_expired"{"expired"}else{"not_activated"}.into();return Ok(value)}};
    let rollback=stored.last_seen>0&&current.saturating_add(86_400)<stored.last_seen;
    if current>=stored.last_seen {stored.last_seen=current;let _=fs::write(&path,serde_json::to_vec_pretty(&stored).unwrap_or_default());}
    Ok(LicenseStatus{device_id:device_id(&app)?,status:if rollback{"expired"}else{"active"}.into(),activation_date:stored.activation_date,expiry_date:payload.expiry_date,remaining_days:if rollback{0}else{((payload.exp-current+86_399)/86_400) as i64},license_id:payload.license_id})
}

#[tauri::command]
pub fn activate_license(app:AppHandle,license:String)->Result<LicenseStatus,String>{
    let payload=verify(&app,&license)?;let current=now();let activation_date=payload.issue_date.clone();
    let stored=Stored{license:license.trim().into(),activation_date,last_seen:current};
    fs::write(dir(&app)?.join("license.json"),serde_json::to_vec_pretty(&stored).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    Ok(LicenseStatus{device_id:device_id(&app)?,status:"active".into(),activation_date:stored.activation_date,expiry_date:payload.expiry_date,remaining_days:((payload.exp-current+86_399)/86_400) as i64,license_id:payload.license_id})
}
