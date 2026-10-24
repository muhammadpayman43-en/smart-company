// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.get(1).map(String::as_str) == Some("--database-worker") {
        spice_management_app_lib::run_database_worker();
        return;
    }
    if arguments.get(1).map(String::as_str) == Some("--database-init") {
        spice_management_app_lib::initialize_api_database();
        return;
    }
    if arguments.get(1).map(String::as_str) == Some("--database-backup") {
        let result = arguments.get(2).zip(arguments.get(3)).ok_or_else(||"invalid_request".to_string()).and_then(|(source, destination)| spice_management_app_lib::backup_database_cli(source, destination));
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    if arguments.get(1).map(String::as_str) == Some("--database-replace") {
        let result=(|| -> Result<(),String>{let source=arguments.get(2).ok_or("invalid_request")?;let destination=arguments.get(3).ok_or("invalid_request")?;let workspace=arguments.get(4).ok_or("invalid_request")?;let revision=arguments.get(5).ok_or("invalid_request")?.parse().map_err(|_|"invalid_request")?;spice_management_app_lib::replace_database_cli(source,destination,workspace,revision)})();
        if let Err(error)=result{eprintln!("{error}");std::process::exit(1)}return;
    }
    spice_management_app_lib::run()
}
