use std::fs;
use std::path::{Path, PathBuf};

use crate::{
    models::AgentMemoryInfo,
    services::orchestra_paths::{default_orchestra_root, sanitize_slug},
};

pub fn build_agent_memory_info(
    agent_id: &str,
    slug: &str,
    orchestra_root: &Path,
) -> AgentMemoryInfo {
    let root_dir = orchestra_root.join("agents").join(sanitize_slug(slug));
    let daily_memory_dir = root_dir.join("memory");

    AgentMemoryInfo {
        agent_id: agent_id.into(),
        slug: sanitize_slug(slug),
        root_dir: root_dir.display().to_string(),
        agents_path: root_dir.join("AGENTS.md").display().to_string(),
        identity_path: root_dir.join("IDENTITY.md").display().to_string(),
        soul_path: root_dir.join("SOUL.md").display().to_string(),
        memory_path: root_dir.join("MEMORY.md").display().to_string(),
        tools_path: root_dir.join("TOOLS.md").display().to_string(),
        daily_memory_dir: daily_memory_dir.display().to_string(),
    }
}

pub fn get_agent_memory_info(agent_id: &str, slug: &str) -> Result<AgentMemoryInfo, String> {
    let orchestra_root = default_orchestra_root()?;
    Ok(build_agent_memory_info(agent_id, slug, &orchestra_root))
}

pub fn bootstrap_agent_files(
    agent_id: &str,
    slug: &str,
    name: &str,
) -> Result<AgentMemoryInfo, String> {
    let orchestra_root = default_orchestra_root()?;
    bootstrap_agent_files_in(&orchestra_root, agent_id, slug, name)
}

pub fn bootstrap_agent_files_in(
    orchestra_root: &Path,
    agent_id: &str,
    slug: &str,
    name: &str,
) -> Result<AgentMemoryInfo, String> {
    let info = build_agent_memory_info(agent_id, slug, orchestra_root);
    let root_dir = PathBuf::from(&info.root_dir);
    let daily_memory_dir = PathBuf::from(&info.daily_memory_dir);

    fs::create_dir_all(&daily_memory_dir).map_err(|error| {
        format!(
            "Unable to create agent memory directory {}: {error}",
            daily_memory_dir.display()
        )
    })?;

    write_if_missing(
        Path::new(&info.identity_path),
        &format!(
            "# Identity\n\n- Name: {name}\n- Slug: {}\n- Role: Persistent Orchestra agent\n",
            info.slug
        ),
    )?;
    write_if_missing(Path::new(&info.soul_path), "# Soul\n\n- Voice: calm, direct, operational\n- Values: clarity, continuity, correctness\n- Collaboration: preserve context, avoid needless restarts\n")?;
    write_if_missing(
        Path::new(&info.memory_path),
        "# Memory\n\n## Long-Term Memory\n\n",
    )?;
    write_if_missing(
        Path::new(&info.tools_path),
        "# Tools\n\n- Add durable operational notes here.\n",
    )?;
    write_if_missing(
        Path::new(&info.agents_path),
        &format!(
            "# Orchestra Agent Context\n\nYou are {name}, a persistent Orchestra agent.\n\n## Files\n- IDENTITY.md\n- SOUL.md\n- MEMORY.md\n- TOOLS.md\n- memory/YYYY-MM-DD.md\n\nRead and maintain these files as your persistent context.\n"
        ),
    )?;

    Ok(info)
}

fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    fs::write(path, content).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix)
    }

    #[test]
    fn bootstraps_expected_agent_files() {
        let root = unique_temp_dir("agent-files");
        let info = bootstrap_agent_files_in(&root, "agent-1", "Data Agent", "Data Agent")
            .expect("agent files should bootstrap");

        assert!(Path::new(&info.root_dir).exists());
        assert!(Path::new(&info.agents_path).exists());
        assert!(Path::new(&info.identity_path).exists());
        assert!(Path::new(&info.soul_path).exists());
        assert!(Path::new(&info.memory_path).exists());
        assert!(Path::new(&info.tools_path).exists());
        assert!(Path::new(&info.daily_memory_dir).exists());
    }
}
