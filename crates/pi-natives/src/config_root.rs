use std::{
	ffi::OsString,
	path::{Component, Path, PathBuf},
};

/// Match the JS bootstrap's explicit, profile-independent PI_CONFIG_ROOT.
pub(crate) fn config_root_override(home: &Path, value: Option<&str>) -> Option<PathBuf> {
	let value = value?.trim();
	if value.is_empty() {
		return None;
	}
	let mut expanded: OsString;
	let path = if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
		expanded = home.as_os_str().to_os_string();
		expanded.push(&value[1..]);
		Path::new(&expanded)
	} else {
		Path::new(value)
	};
	if !path.is_absolute() {
		return None;
	}
	let mut normalized = PathBuf::with_capacity(path.as_os_str().len());
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				normalized.pop();
			},
			_ => normalized.push(component.as_os_str()),
		}
	}
	Some(normalized)
}

pub(crate) fn native_oauth_root(
	home: &Path,
	root_override: Option<&str>,
	platform: &str,
	scheme: &str,
) -> PathBuf {
	let mut root = config_root_override(home, root_override).unwrap_or_else(|| home.join(".omp"));
	root.extend(["oauth", "native", platform, scheme]);
	root
}

#[cfg(test)]
mod tests {
	use super::*;

	fn home() -> &'static Path {
		if cfg!(windows) {
			Path::new("C:/users/probe")
		} else {
			Path::new("/home/probe")
		}
	}

	#[test]
	fn normalizes_an_explicit_absolute_root() {
		let (input, expected) = if cfg!(windows) {
			("  F:/state/../omp  ", "F:/omp")
		} else {
			("  /var/state/../omp  ", "/var/omp")
		};
		assert_eq!(config_root_override(home(), Some(input)), Some(PathBuf::from(expected)));
	}

	#[test]
	fn expands_home_and_home_relative_paths() {
		assert_eq!(config_root_override(home(), Some("~")), Some(home().to_path_buf()));
		assert_eq!(config_root_override(home(), Some(" ~/state/../omp ")), Some(home().join("omp")));
		let mut expected = home().as_os_str().to_os_string();
		expected.push("\\omp");
		assert_eq!(config_root_override(home(), Some("~\\omp")), Some(PathBuf::from(expected)));
	}

	#[test]
	fn ignores_unset_empty_and_relative_roots() {
		for value in [None, Some(""), Some(" \t "), Some("relative/state")] {
			assert_eq!(config_root_override(home(), value), None);
		}
	}

	#[test]
	fn oauth_storage_uses_the_selected_root_without_moving_home() {
		let root = if cfg!(windows) {
			"F:/state"
		} else {
			"/var/state"
		};
		assert_eq!(
			native_oauth_root(home(), Some(root), "windows", "omp-test"),
			Path::new(root).join("oauth/native/windows/omp-test")
		);
		for value in [None, Some(" "), Some("relative/state")] {
			assert_eq!(
				native_oauth_root(home(), value, "windows", "omp-test"),
				home().join(".omp/oauth/native/windows/omp-test")
			);
		}
	}

	#[cfg(windows)]
	#[test]
	fn rejects_drive_relative_roots_and_accepts_unc_without_accessing_it() {
		for value in ["C:relative", "\\root-relative", "/root-relative"] {
			assert_eq!(config_root_override(home(), Some(value)), None);
		}
		assert_eq!(
			config_root_override(home(), Some(r"\\server\share\state\..\omp")),
			Some(PathBuf::from(r"\\server\share\omp"))
		);
	}
}
