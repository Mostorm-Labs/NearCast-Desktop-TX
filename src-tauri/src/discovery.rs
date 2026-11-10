use mdns_sd::ServiceEvent;
use serde::Serialize;
use std::{collections::BTreeMap, net::{IpAddr, SocketAddr, TcpStream}, time::{Duration, Instant}};

pub const SERVICE_TYPES: [&str; 1] = ["_nearcast._tcp.local."];
pub const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(15);
pub const BRIDGE_LEASE_MS: u64 = 45000;

#[derive(Debug, Clone, Serialize)]
pub struct MdnsService {
    pub service_type: String,
    pub instance: String,
    pub hostname: String,
    pub port: u16,
    pub addresses: Vec<String>,
    pub txt: BTreeMap<String, String>,
}

#[derive(Default)]
pub struct DiscoveryCache { entries: BTreeMap<String, MdnsService> }

impl DiscoveryCache {
    pub fn apply(&mut self, event: ServiceEvent) -> bool {
        match event {
            ServiceEvent::ServiceResolved(info) if SERVICE_TYPES.contains(&info.get_type()) => {
                let key = format!("{}:{}", info.get_type(), info.get_fullname());
                if self.entries.len() >= 512 && !self.entries.contains_key(&key) { return false; }
                let mut addresses = info.get_addresses().iter().map(ToString::to_string).collect::<Vec<_>>();
                addresses.sort();
                self.entries.insert(key, MdnsService {service_type: info.get_type().into(), instance: info.get_fullname().into(), hostname: info.get_hostname().into(), port: info.get_port(), addresses,
                    txt: info.get_properties().iter().map(|property| (property.key().to_string(), property.val_str().to_string())).collect()});
                true
            }
            ServiceEvent::ServiceRemoved(ty, name) => self.entries.remove(&format!("{}:{}", ty, name)).is_some(),
            _ => false,
        }
    }

    pub fn snapshot(&self, service_type: &str) -> Vec<MdnsService> {
        self.entries.values().filter(|entry| entry.service_type == service_type).cloned().collect()
    }

    pub fn clear(&mut self) { self.entries.clear(); }
    pub fn remove_type(&mut self, service_type: &str) { self.entries.retain(|_, service| service.service_type != service_type); }

    pub fn code_display_target(&self, instance: &str, device_id: &str) -> Result<ResolvedTarget, String> {
        self.display_target(instance, device_id, "code-display-v1")
    }
    pub fn trust_display_target(&self, instance: &str, device_id: &str) -> Result<ResolvedTarget, String> {
        self.display_target(instance, device_id, "trust-display-v1")
    }
    fn display_target(&self, instance: &str, device_id: &str, capability: &str) -> Result<ResolvedTarget, String> {
        let entry = self.entries.get(&format!("_nearcast._tcp.local.:{instance}")).ok_or("Receiver discovery expired; scan again")?;
        let id = entry.txt.get("deviceId").or_else(|| entry.txt.get("device_id")).or_else(|| entry.txt.get("id"));
        let capabilities = entry.txt.get("capability").map(String::as_str).unwrap_or("")
            .split(|c: char| c.is_whitespace() || c == ',' || c == ';').map(str::to_ascii_lowercase).collect::<Vec<_>>();
        if device_id.is_empty() || id.map(String::as_str) != Some(device_id) || !capabilities.iter().any(|c| c == "webcast") || !capabilities.iter().any(|c| c == capability) || entry.port == 0 {
            return Err("Receiver does not support this display request".into());
        }
        let addresses = entry.addresses.iter().filter_map(|address| address.parse::<IpAddr>().ok()).filter(|address| !address.is_unspecified() && !address.is_multicast()).collect();
        Ok(ResolvedTarget {hostname: entry.hostname.clone(), port: entry.port, addresses})
    }
}

pub struct ResolvedTarget {
    pub hostname: String,
    pub port: u16,
    pub addresses: Vec<IpAddr>,
}

impl ResolvedTarget {
    pub fn reachable_url(&self, timeout: Duration) -> Result<tauri::Url, String> {
        // Only probe addresses supplied by the SRV target's A/AAAA records. TXT
        // never adds a destination. A TCP success does not grant TLS trust.
        let deadline = Instant::now() + timeout;
        let mut addresses = self.addresses.clone();
        addresses.sort_by_key(|address| (address.is_ipv6(), *address));
        for address in addresses.iter().take(8) {
            let remaining = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(250));
            if remaining.is_zero() { break; }
            if TcpStream::connect_timeout(&SocketAddr::new(*address, self.port), remaining).is_ok() {
                return tauri::Url::parse(&format!("https://{}/nearcast/code-display", SocketAddr::new(*address, self.port))).map_err(|_| "Invalid resolved receiver endpoint".into());
            }
        }
        Err(format!("无法连接已解析的接收端 {}，请检查网络后重新扫描。", self.hostname.trim_end_matches('.')))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdns_sd::ServiceInfo;
    use std::net::{IpAddr, Ipv4Addr, TcpListener};

    fn service(instance: &str) -> ServiceInfo {
        ServiceInfo::new("_nearcast._tcp.local.", instance, "board.local.", "192.0.2.21", 8443,
            [("id", "board"), ("capability", "webcast,code-display-v1"), ("endpoint", "https://unrelated.invalid:1234")].as_slice()).unwrap()
    }

    #[test]
    fn native_cache_keeps_service_until_dns_removal_instead_of_txt_lease_expiry() {
        let mut cache = DiscoveryCache::default();
        cache.apply(ServiceEvent::ServiceResolved(service("Board")));
        for _ in 0..8 { // snapshots spanning >60 seconds do not evict unchanged DNS records
            let snapshot = cache.snapshot("_nearcast._tcp.local.");
            assert_eq!(snapshot.len(), 1);
        }
        cache.apply(ServiceEvent::ServiceRemoved("_nearcast._tcp.local.".into(), "Board._nearcast._tcp.local.".into()));
        assert!(cache.snapshot("_nearcast._tcp.local.").is_empty());
    }

    #[test]
    fn trust_bootstrap_requires_its_own_capability_and_exact_device_identity() {
        let mut cache = DiscoveryCache::default();
        cache.apply(ServiceEvent::ServiceResolved(service("Board")));
        assert!(cache.trust_display_target("Board._nearcast._tcp.local.", "board").is_err());
        let info = ServiceInfo::new("_nearcast._tcp.local.", "Board", "board.local.", "192.0.2.21", 8443, [("id", "board"), ("capability", "webcast,trust-display-v1")].as_slice()).unwrap();
        cache.apply(ServiceEvent::ServiceResolved(info));
        assert!(cache.trust_display_target("Board._nearcast._tcp.local.", "board").is_ok());
        assert!(cache.trust_display_target("Board._nearcast._tcp.local.", "BOARD").is_err());
        assert!(cache.code_display_target("Board._nearcast._tcp.local.", "board").is_err());
    }

    #[test]
    fn request_route_comes_from_exact_native_service_and_never_txt_authority() {
        let mut cache = DiscoveryCache::default();
        cache.apply(ServiceEvent::ServiceResolved(service("Board")));
        let resolved = cache.code_display_target("Board._nearcast._tcp.local.", "board").unwrap();
        assert_eq!(resolved.port, 8443);
        assert_eq!(resolved.hostname, "board.local.");
        assert_eq!(resolved.addresses, vec![IpAddr::V4(Ipv4Addr::new(192,0,2,21))]);
        assert!(cache.code_display_target("Unknown._nearcast._tcp.local.", "board").is_err());
        assert!(cache.code_display_target("Board._nearcast._tcp.local.", "other").is_err());
        cache.apply(ServiceEvent::ServiceRemoved("_nearcast._tcp.local.".into(), "Board._nearcast._tcp.local.".into()));
        assert!(cache.code_display_target("Board._nearcast._tcp.local.", "board").is_err());
    }

    #[test]
    fn reachable_address_is_chosen_from_srv_addresses_not_the_txt_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = ResolvedTarget {hostname: "unresolvable.invalid.".into(),port:listener.local_addr().unwrap().port(),addresses:vec!["127.0.0.2".parse().unwrap(), "127.0.0.1".parse().unwrap()]};
        let url = target.reachable_url(Duration::from_millis(100)).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.path(), "/nearcast/code-display");
        assert_eq!(url.port(), Some(target.port));
    }

    #[test]
    fn airplay_or_missing_capability_cannot_authorize_native_display_requests() {
        let mut cache = DiscoveryCache::default();
        for (ty, cap) in [("_airplay._tcp.local.", "webcast,code-display-v1"), ("_raop._tcp.local.", "webcast,code-display-v1"), ("_nearcast._tcp.local.", "webcast")] {
            let info = ServiceInfo::new(ty, "TV", "tv.local.", "192.0.2.22", 8443, [("id", "tv"),("capability",cap)].as_slice()).unwrap();
            let instance = info.get_fullname().to_string();
            let accepted = cache.apply(ServiceEvent::ServiceResolved(info));
            if ty != "_nearcast._tcp.local." {
                assert!(!accepted);
                assert!(cache.snapshot(ty).is_empty());
            }
            assert!(cache.code_display_target(&instance, "tv").is_err());
        }
    }

    #[test]
    fn stopping_or_losing_the_native_browser_clears_its_snapshots() {
        let mut cache = DiscoveryCache::default();
        cache.apply(ServiceEvent::ServiceResolved(service("Board")));
        cache.remove_type("_nearcast._tcp.local.");
        assert!(cache.snapshot("_nearcast._tcp.local.").is_empty());
        cache.apply(ServiceEvent::ServiceResolved(service("Board")));
        cache.clear();
        assert!(cache.snapshot("_nearcast._tcp.local.").is_empty());
    }

    #[test]
    #[ignore = "Live LAN mDNS fixture; runs for at least 66 seconds"]
    fn live_mdns_survives_sixty_seconds_then_withdraws_on_unregister() {
        use mdns_sd::{ServiceDaemon, UnregisterStatus};
        let publisher = ServiceDaemon::new().unwrap();
        let browser = ServiceDaemon::new().unwrap();
        let receiver = browser.browse("_nearcast._tcp.local.").unwrap();
        let instance = format!("NearCast-TX-test-{}", std::process::id());
        let info = ServiceInfo::new("_nearcast._tcp.local.", &instance, &format!("nearcast-tx-test-{}.local.", std::process::id()), "", 58443,
            [("id","fixture"),("capability","webcast"),("ttl","60")].as_slice()).unwrap().enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        publisher.register(info).unwrap();
        let mut cache = DiscoveryCache::default();
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline && cache.snapshot("_nearcast._tcp.local.").iter().all(|entry| entry.instance != fullname) {
            if let Ok(event) = receiver.recv_timeout(Duration::from_millis(500)) { cache.apply(event); }
        }
        assert!(cache.snapshot("_nearcast._tcp.local.").iter().any(|entry| entry.instance == fullname), "fixture must resolve");
        let until = Instant::now() + Duration::from_secs(66); let mut ticks = 0;
        while Instant::now() < until {
            let next = (Instant::now() + SNAPSHOT_INTERVAL).min(until);
            while Instant::now() < next {
                if let Ok(event) = receiver.recv_timeout(Duration::from_millis(200)) { cache.apply(event); }
            }
            assert!(cache.snapshot("_nearcast._tcp.local.").iter().any(|entry| entry.instance == fullname), "unchanged receiver must remain visible beyond TXT ttl");
            ticks += 1;
        }
        let status = publisher.unregister(&fullname).unwrap();
        assert!(matches!(status.recv_timeout(Duration::from_secs(3)).unwrap(), UnregisterStatus::OK));
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && cache.snapshot("_nearcast._tcp.local.").iter().any(|entry| entry.instance == fullname) {
            if let Ok(event) = receiver.recv_timeout(Duration::from_millis(200)) { cache.apply(event); }
        }
        let removed = cache.snapshot("_nearcast._tcp.local.").iter().all(|entry| entry.instance != fullname);
        let _ = publisher.shutdown(); let _ = browser.shutdown();
        assert!(removed, "goodbye must withdraw the active receiver");
        println!("Live fixture: {ticks} snapshots spanning 66 seconds, then unregister removal confirmed");
    }
}
