fn main() {
    println!("cargo:rerun-if-env-changed=NEARCAST_BUILD_NUMBER");
    println!("cargo:rerun-if-env-changed=NEARCAST_LOGICAL_VERSION");
    let build = std::env::var("NEARCAST_BUILD_NUMBER").unwrap_or_else(|_| "0".into());
    assert!(
        !build.is_empty() && build.bytes().all(|c| c.is_ascii_digit()),
        "Invalid NEARCAST_BUILD_NUMBER"
    );
    build
        .parse::<u64>()
        .expect("NEARCAST_BUILD_NUMBER overflow");
    println!("cargo:rustc-env=NEARCAST_BUILD_NUMBER={build}");
    let logical = std::env::var("NEARCAST_LOGICAL_VERSION")
        .unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap());
    assert!(
        logical.split('.').count() == 3
            && logical
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())),
        "Invalid NEARCAST_LOGICAL_VERSION"
    );
    println!("cargo:rustc-env=NEARCAST_LOGICAL_VERSION={logical}");
    tauri_build::build();
}
