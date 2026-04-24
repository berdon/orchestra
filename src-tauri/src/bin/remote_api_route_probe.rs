fn main() {
    let case = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: remote_api_route_probe <frontend_bootstrap|session_message|hosted_web_entrypoint|task_list_parity|inbox_parity|sessions_parity>");
        std::process::exit(2);
    });

    if let Err(error) = orchestra::run_remote_api_route_probe(&case) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
