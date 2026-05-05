use std::{env, ffi::OsString, path::PathBuf};

const ORCHESTRA_HOME_FLAG: &str = "--orchestra-home";
const DEV_STORAGE_DIR_NAME: &str = ".orchestra-dev";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedStartupOptions {
    pub orchestra_home: Option<PathBuf>,
    pub remaining_args: Vec<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupStorageRoot {
    CliArgument(PathBuf),
    Environment(PathBuf),
    DesktopDevDefault(PathBuf),
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedStartup {
    pub orchestra_home: Option<PathBuf>,
    pub remaining_args: Vec<OsString>,
    pub storage_root: StartupStorageRoot,
}

pub fn parse_startup_options<I, S>(args: I) -> Result<ParsedStartupOptions, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut orchestra_home = None;
    let mut remaining_args = Vec::new();
    let mut args = args.into_iter().map(Into::into);

    if let Some(program_name) = args.next() {
        remaining_args.push(program_name);
    }

    while let Some(arg) = args.next() {
        if arg == "--" {
            remaining_args.push(arg);
            remaining_args.extend(args);
            break;
        }

        if arg == ORCHESTRA_HOME_FLAG {
            let Some(value) = args.next() else {
                return Err(format!("{ORCHESTRA_HOME_FLAG} requires a path value"));
            };
            orchestra_home = Some(parse_split_orchestra_home_value(value)?);
            continue;
        }

        if let Some(arg_value) = arg.to_str() {
            if let Some(value) = arg_value.strip_prefix("--orchestra-home=") {
                orchestra_home = Some(parse_inline_orchestra_home_value(value)?);
                continue;
            }
        }

        remaining_args.push(arg);
    }

    Ok(ParsedStartupOptions {
        orchestra_home,
        remaining_args,
    })
}

pub fn resolve_startup_storage_root(
    cli_override: Option<PathBuf>,
    env_override: Option<PathBuf>,
    home_dir: Option<PathBuf>,
    use_desktop_dev_default: bool,
) -> Result<StartupStorageRoot, String> {
    if let Some(path) = non_empty_path(cli_override) {
        return Ok(StartupStorageRoot::CliArgument(path));
    }

    if let Some(path) = non_empty_path(env_override) {
        return Ok(StartupStorageRoot::Environment(path));
    }

    if use_desktop_dev_default {
        let home_dir = non_empty_path(home_dir).ok_or_else(|| {
            "HOME is not set; unable to resolve Orchestra dev storage root".to_string()
        })?;
        return Ok(StartupStorageRoot::DesktopDevDefault(
            home_dir.join(DEV_STORAGE_DIR_NAME),
        ));
    }

    Ok(StartupStorageRoot::Default)
}

pub fn desktop_tauri_dev_default_enabled() -> bool {
    matches!(option_env!("ORCHESTRA_TAURI_IS_DEV"), Some("true"))
}

pub fn prepare_process_startup(use_desktop_dev_default: bool) -> Result<PreparedStartup, String> {
    let parsed = parse_startup_options(env::args_os())?;
    let env_override = env::var_os("ORCHESTRA_STORAGE_ROOT").map(PathBuf::from);
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let storage_root = resolve_startup_storage_root(
        parsed.orchestra_home.clone(),
        env_override,
        home_dir,
        use_desktop_dev_default,
    )?;

    match &storage_root {
        StartupStorageRoot::CliArgument(path) | StartupStorageRoot::DesktopDevDefault(path) => {
            env::set_var("ORCHESTRA_STORAGE_ROOT", path)
        }
        StartupStorageRoot::Environment(_) | StartupStorageRoot::Default => {}
    }

    Ok(PreparedStartup {
        orchestra_home: parsed.orchestra_home,
        remaining_args: parsed.remaining_args,
        storage_root,
    })
}

fn parse_inline_orchestra_home_value(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err(format!(
            "{ORCHESTRA_HOME_FLAG} requires a non-empty path value"
        ));
    }

    Ok(PathBuf::from(value))
}

fn parse_split_orchestra_home_value(value: OsString) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err(format!(
            "{ORCHESTRA_HOME_FLAG} requires a non-empty path value"
        ));
    }

    if value == "--" || value.to_string_lossy().starts_with('-') {
        return Err(format!(
            "{ORCHESTRA_HOME_FLAG} requires a path value before the next flag"
        ));
    }

    Ok(PathBuf::from(value))
}

fn non_empty_path(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|candidate| !candidate.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_startup_options_supports_split_orchestra_home_flag() {
        let parsed = parse_startup_options([
            "orc",
            "--orchestra-home",
            "/tmp/orchestra-dev",
            "task",
            "list",
        ])
        .expect("split orchestra home flag should parse");

        assert_eq!(
            parsed.orchestra_home,
            Some(PathBuf::from("/tmp/orchestra-dev"))
        );
        assert_eq!(
            parsed.remaining_args,
            vec!["orc", "task", "list"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn parse_startup_options_supports_inline_orchestra_home_flag() {
        let parsed =
            parse_startup_options(["orc", "task", "list", "--orchestra-home=/tmp/orchestra-dev"])
                .expect("inline orchestra home flag should parse");

        assert_eq!(
            parsed.orchestra_home,
            Some(PathBuf::from("/tmp/orchestra-dev"))
        );
        assert_eq!(
            parsed.remaining_args,
            vec!["orc", "task", "list"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn parse_startup_options_stops_scanning_after_double_dash() {
        let parsed = parse_startup_options(["orc", "msg", "--", "--orchestra-home", "literal"])
            .expect("double dash should stop startup option scanning");

        assert_eq!(parsed.orchestra_home, None);
        assert_eq!(
            parsed.remaining_args,
            vec!["orc", "msg", "--", "--orchestra-home", "literal"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn parse_startup_options_rejects_missing_split_value() {
        let error = parse_startup_options(["orc", "--orchestra-home"])
            .expect_err("missing orchestra home value should fail");

        assert!(error.contains("requires a path value"));
    }

    #[test]
    fn parse_startup_options_rejects_empty_inline_value() {
        let error = parse_startup_options(["orc", "--orchestra-home="])
            .expect_err("empty orchestra home value should fail");

        assert!(error.contains("non-empty path"));
    }

    #[test]
    fn parse_startup_options_rejects_next_flag_as_split_value() {
        let error = parse_startup_options(["orc", "--orchestra-home", "--project", "task"])
            .expect_err("next flag should not be accepted as orchestra home");

        assert!(error.contains("before the next flag"));
    }

    #[test]
    fn resolve_startup_storage_root_prefers_cli_override() {
        let resolved = resolve_startup_storage_root(
            Some(PathBuf::from("/tmp/cli")),
            Some(PathBuf::from("/tmp/env")),
            Some(PathBuf::from("/Users/test")),
            true,
        )
        .expect("startup storage root should resolve");

        assert_eq!(
            resolved,
            StartupStorageRoot::CliArgument(PathBuf::from("/tmp/cli"))
        );
    }

    #[test]
    fn resolve_startup_storage_root_falls_back_to_environment_override() {
        let resolved = resolve_startup_storage_root(
            None,
            Some(PathBuf::from("/tmp/env")),
            Some(PathBuf::from("/Users/test")),
            true,
        )
        .expect("startup storage root should resolve");

        assert_eq!(
            resolved,
            StartupStorageRoot::Environment(PathBuf::from("/tmp/env"))
        );
    }

    #[test]
    fn resolve_startup_storage_root_uses_desktop_dev_default_when_requested() {
        let resolved =
            resolve_startup_storage_root(None, None, Some(PathBuf::from("/Users/test")), true)
                .expect("desktop dev default should resolve");

        assert_eq!(
            resolved,
            StartupStorageRoot::DesktopDevDefault(PathBuf::from("/Users/test/.orchestra-dev"))
        );
    }

    #[test]
    fn resolve_startup_storage_root_uses_default_for_packaged_desktop_without_overrides() {
        let resolved =
            resolve_startup_storage_root(None, None, Some(PathBuf::from("/Users/test")), false)
                .expect("packaged desktop startup should keep the normal default storage root");

        assert_eq!(resolved, StartupStorageRoot::Default);
    }

    #[test]
    fn resolve_startup_storage_root_keeps_default_when_no_override_exists() {
        let resolved = resolve_startup_storage_root(None, None, None, false)
            .expect("default startup storage root should remain unset");

        assert_eq!(resolved, StartupStorageRoot::Default);
    }
}
