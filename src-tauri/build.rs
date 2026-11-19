fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref()==Ok("macos") {
        println!("cargo:rerun-if-changed=src/gesture_halo.m");
        cc::Build::new().file("src/gesture_halo.m").flag("-fobjc-arc").flag("-fblocks").compile("nearcast_gesture_halo");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=src/macos_local_network.m");
        cc::Build::new().file("src/macos_local_network.m").flag("-fobjc-arc").flag("-fblocks").flag("-mmacosx-version-min=13.0").compile("nearcast_local_network");
        println!("cargo:rustc-link-lib=framework=Network");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rerun-if-changed=src/macos_app_icon.m");
        cc::Build::new().file("src/macos_app_icon.m").flag("-fobjc-arc").compile("nearcast_app_icon");
        println!("cargo:rerun-if-changed=src/macos_system_audio.m");
        println!("cargo:rerun-if-changed=src/macos_core_audio.m");
        cc::Build::new().file("src/macos_core_audio.m").flag("-fobjc-arc").flag("-fblocks").flag("-mmacosx-version-min=13.0").compile("nearcast_core_audio");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=AVFAudio");
        cc::Build::new().file("src/macos_system_audio.m").flag("-fobjc-arc").flag("-fblocks").flag("-mmacosx-version-min=13.0").compile("nearcast_system_audio");
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        // Objective-C @available uses Clang's compiler runtime. Rust's
        // -nodefaultlibs link (notably with release LTO) must request it
        // explicitly rather than rely on incidental libstd exports.
        let runtime = cc::Build::new().get_compiler().to_command()
            .arg("-print-file-name=libclang_rt.osx.a").output()
            .expect("Could not locate the Clang macOS runtime");
        assert!(runtime.status.success(), "Clang macOS runtime lookup failed");
        let runtime = std::path::PathBuf::from(
            String::from_utf8(runtime.stdout).expect("Invalid Clang runtime path").trim());
        assert!(runtime.is_file(), "Clang macOS runtime is missing: {}", runtime.display());
        println!("cargo:rustc-link-search=native={}", runtime.parent().unwrap().display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
    println!("cargo:rerun-if-env-changed=NEARCAST_BUILD_VERSION");
    println!("cargo:rerun-if-changed=../build-version.json");
    println!("cargo:rerun-if-env-changed=NEARCAST_UPDATE_CHANNEL");
    let channel=std::env::var("NEARCAST_UPDATE_CHANNEL").unwrap_or_else(|_|"release".into());
    assert!(["release","beta","alpha"].contains(&channel.as_str()),"Invalid NEARCAST_UPDATE_CHANNEL");
    println!("cargo:rustc-env=NEARCAST_UPDATE_CHANNEL={channel}");
    let counter:serde_json::Value=serde_json::from_str(&std::fs::read_to_string("../build-version.json").expect("Missing build-version.json")).expect("Invalid build counter");
    let build=counter["build"].as_u64().filter(|n|*n<=65535).expect("Build counter out of range");
    let logical=counter["logicalVersion"].as_str().expect("Missing logical version");
    let display=format!("{logical}.{build}");
    if let Ok(assigned)=std::env::var("NEARCAST_BUILD_VERSION"){assert_eq!(assigned,display,"Assigned build differs from counter file");}
    println!("cargo:rustc-env=NEARCAST_BUILD_NUMBER={build}");
    assert!(
        logical.split('.').count() == 3
            && logical
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())&&part.parse::<u16>().is_ok()&&(part=="0"||!part.starts_with('0'))),
        "Invalid NEARCAST_LOGICAL_VERSION"
    );
    println!("cargo:rustc-env=NEARCAST_LOGICAL_VERSION={logical}");
    tauri_build::build();
}
