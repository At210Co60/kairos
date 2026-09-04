//! 系统监控真实数据：CPU / 内存 / 磁盘 / 网络（sysinfo）

use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sysinfo::{Disks, Networks, System};

pub struct SystemState {
    pub sys: Mutex<System>,
    pub nets: Mutex<Networks>,
    pub last_net: Mutex<Option<(u64, u64, Instant)>>,
}

#[tauri::command]
pub fn system_stats(
    state: tauri::State<'_, Arc<SystemState>>,
) -> Result<serde_json::Value, String> {
    // CPU + 内存
    let (cpu, mem_used_gb, mem_total_gb) = {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let cpu = sys.global_cpu_usage() as f64;
        let mem_used = sys.used_memory() as f64 / 1_073_741_824.0;
        let mem_total = sys.total_memory() as f64 / 1_073_741_824.0;
        (cpu, mem_used, mem_total)
    };

    // 磁盘（所有分区合计）
    let disks = Disks::new_with_refreshed_list();
    let mut disk_total = 0.0f64;
    let mut disk_avail = 0.0f64;
    for d in disks.list() {
        disk_total += d.total_space() as f64;
        disk_avail += d.available_space() as f64;
    }
    let disk_used = disk_total - disk_avail;

    // 网络：sysinfo 的 received/transmitted 是自上次刷新的增量，除以间隔得速率
    let (down_mbs, up_mbs) = {
        let mut nets = state.nets.lock().unwrap();
        nets.refresh(true);
        let mut rx = 0u64;
        let mut tx = 0u64;
        for (_name, data) in nets.iter() {
            rx += data.received();
            tx += data.transmitted();
        }
        let now = Instant::now();
        let rate = {
            let last = state.last_net.lock().unwrap();
            match *last {
                Some((prx, ptx, at)) => {
                    let dt = now.duration_since(at).as_secs_f64().max(0.001);
                    (
                        (rx.saturating_sub(prx)) as f64 / dt / 1_048_576.0,
                        (tx.saturating_sub(ptx)) as f64 / dt / 1_048_576.0,
                    )
                }
                None => (0.0, 0.0),
            }
        };
        *state.last_net.lock().unwrap() = Some((rx, tx, now));
        rate
    };

    Ok(json!({
        "cpu": (cpu * 10.0).round() / 10.0,
        "memUsed": (mem_used_gb * 10.0).round() / 10.0,
        "memTotal": (mem_total_gb * 10.0).round() / 10.0,
        "diskUsed": (disk_used / 1_073_741_824.0 * 10.0).round() / 10.0,
        "diskTotal": (disk_total / 1_073_741_824.0 * 10.0).round() / 10.0,
        "netDown": (down_mbs * 10.0).round() / 10.0,
        "netUp": (up_mbs * 10.0).round() / 10.0,
    }))
}

pub fn init_system_state() -> Arc<SystemState> {
    let mut sys = System::new();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let mut nets = Networks::new_with_refreshed_list();
    nets.refresh(true);
    Arc::new(SystemState {
        sys: Mutex::new(sys),
        nets: Mutex::new(nets),
        last_net: Mutex::new(None),
    })
}
