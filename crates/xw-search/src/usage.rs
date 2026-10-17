//! 最近使用加权，纯内存、重启清空。由 SearchEngine 持有。

use std::collections::HashMap;
use std::sync::RwLock;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 加权因子的半衰期：最近一次使用距今达此时长时，recency 衰减到一半。
const HALF_LIFE_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// 频次系数下限：只要用过一次也给一定加权，多次使用再往上抬到 1。
const FREQ_FLOOR: f64 = 0.5;

/// 单个结果的使用统计。
#[derive(Debug, Clone, Copy)]
pub struct UsageRecord {
    pub hits: u32,
    /// 最近一次使用的 Unix 毫秒。
    pub last_used_at: i64,
}

/// 依据记录与「当下时刻」计算加权因子 `∈ [0,1]`：`recency 衰减 × 频次系数`。
fn factor_at(rec: &UsageRecord, now_ms: i64) -> f32 {
    let age = (now_ms - rec.last_used_at).max(0) as f64;
    // 指数时间衰减：越久没用越接近 0，刚用过 ≈ 1。
    let recency = 0.5_f64.powf(age / HALF_LIFE_MS);
    // 频次：hits=1 → 0.5，随次数趋近 1；再映射到 [FREQ_FLOOR, 1]。
    let hits = rec.hits.max(1) as f64;
    let freq = 1.0 - 1.0 / (1.0 + hits);
    let factor = recency * (FREQ_FLOOR + (1.0 - FREQ_FLOOR) * freq);
    factor as f32
}

#[derive(Default)]
pub struct UsageStore {
    records: RwLock<HashMap<String, UsageRecord>>,
}

impl UsageStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记一次使用：`hits += 1` 且刷新 `last_used_at`。
    pub fn record(&self, key: &str) {
        let now = now_ms();
        let Ok(mut guard) = self.records.write() else {
            return;
        };
        let rec = guard.entry(key.to_string()).or_insert(UsageRecord {
            hits: 0,
            last_used_at: now,
        });
        rec.hits = rec.hits.saturating_add(1);
        rec.last_used_at = now;
    }
}

impl UsageStore {
    /// 结果 `key` 的加权因子 `∈ [0,1]`；无记录返回 `0`。
    pub fn factor(&self, key: &str) -> f32 {
        let now = now_ms();
        let Ok(guard) = self.records.read() else {
            return 0.0;
        };
        guard.get(key).map(|rec| factor_at(rec, now)).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn absent_key_has_zero_factor() {
        let store = UsageStore::new();
        assert_eq!(store.factor("app:none"), 0.0);
    }

    #[test]
    fn record_accumulates_hits() {
        let store = UsageStore::new();
        store.record("app:a");
        store.record("app:a");
        let guard = store.records.read().unwrap();
        assert_eq!(guard.get("app:a").unwrap().hits, 2);
    }

    #[test]
    fn fresh_beats_old() {
        let now = 100 * DAY_MS;
        let fresh = UsageRecord {
            hits: 1,
            last_used_at: now,
        };
        let old = UsageRecord {
            hits: 1,
            last_used_at: now - 30 * DAY_MS,
        };
        assert!(factor_at(&fresh, now) > factor_at(&old, now));
    }

    #[test]
    fn more_hits_beats_fewer_when_equally_recent() {
        let now = 100 * DAY_MS;
        let many = UsageRecord {
            hits: 10,
            last_used_at: now,
        };
        let few = UsageRecord {
            hits: 1,
            last_used_at: now,
        };
        assert!(factor_at(&many, now) > factor_at(&few, now));
    }

    #[test]
    fn factor_within_unit_range_and_decays() {
        let now = 100 * DAY_MS;
        let rec = UsageRecord {
            hits: 3,
            last_used_at: now,
        };
        let f = factor_at(&rec, now);
        assert!((0.0..=1.0).contains(&f));
        // 久未使用趋近 0。
        let stale = UsageRecord {
            hits: 3,
            last_used_at: now - 365 * DAY_MS,
        };
        assert!(factor_at(&stale, now) < 0.1);
    }
}
