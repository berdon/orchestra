fn main() {
    if let Err(error) = orchestra::run_remote_api_route_probe_from_process_args() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
