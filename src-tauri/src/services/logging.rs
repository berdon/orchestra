use tracing_subscriber::fmt::time::UtcTime;

pub fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_timer(UtcTime::rfc_3339())
        .with_target(true)
        .try_init();
}
