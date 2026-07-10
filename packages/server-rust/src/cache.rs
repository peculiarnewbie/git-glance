use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::types::{GitRepo, PersistedConfig};

pub struct CacheService {
    cache_path: PathBuf,
    config_path: PathBuf,
    inner: Arc<RwLock<CacheInner>>,
}

struct CacheInner {
    scanned_dirs: Vec<String>,
}

impl CacheService {
    pub fn new(cache_path: PathBuf, config_path: PathBuf) -> Self {
        Self {
            cache_path,
            config_path,
            inner: Arc::new(RwLock::new(CacheInner {
                scanned_dirs: Vec::new(),
            })),
        }
    }

    pub async fn load(&self) -> Vec<GitRepo> {
        let data = match tokio::fs::read(&self.cache_path).await {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        serde_json::from_slice(&data).unwrap_or_default()
    }

    pub async fn save(&self, repos: &[GitRepo]) {
        if let Some(parent) = self.cache_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(data) = serde_json::to_vec(repos) {
            let _ = tokio::fs::write(&self.cache_path, data).await;
        }
    }

    pub async fn load_config(&self) -> PersistedConfig {
        let data = match tokio::fs::read(&self.config_path).await {
            Ok(d) => d,
            Err(_) => return PersistedConfig::default(),
        };
        serde_json::from_slice(&data).unwrap_or_default()
    }

    pub async fn save_config(&self, cfg: &PersistedConfig) {
        if let Some(parent) = self.config_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(data) = serde_json::to_string_pretty(cfg) {
            let _ = tokio::fs::write(&self.config_path, data).await;
        }
    }

    pub async fn get_scanned_dirs(&self) -> Vec<String> {
        let inner = self.inner.read().await;
        inner.scanned_dirs.clone()
    }

    pub async fn add_scanned_dir(&self, dir: &str) {
        let mut inner = self.inner.write().await;
        if !inner.scanned_dirs.iter().any(|d| d == dir) {
            inner.scanned_dirs.push(dir.to_string());
        }
    }

    pub async fn get_all_repos(&self) -> Vec<GitRepo> {
        self.load().await
    }
}
