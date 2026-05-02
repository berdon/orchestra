fn main() {
    if let Err(error) = orchestra::run_hosted_web_e2e_server_from_process_args() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
