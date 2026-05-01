use std::sync::{Mutex, OnceLock};

static GLOBAL_TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn global_test_env_lock() -> &'static Mutex<()> {
    GLOBAL_TEST_ENV_LOCK.get_or_init(|| Mutex::new(()))
}
