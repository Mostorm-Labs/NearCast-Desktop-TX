# NearHub Cast installer presentation

The application, installed shortcuts, and macOS app bundle are named **NearHub Cast**.
The NSIS caption and executable FileDescription are **NearHub Cast Desktop Installer**;
MSI package summary Description uses the same name, while its installed ProductName
remains the application name.

`installer.nsi` and `main.wxs` are based on the stock Tauri templates from
`tauri-cli-v2.12.4`, under the Tauri repository's Apache-2.0/MIT license:

- https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
- https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/msi/main.wxs

Only installer presentation is customized. Registry paths, upgrade identity, and
installation locations follow the new product name. No legacy-name migration is
required because the previous product has never been installed. When upgrading
the Tauri bundler, review these templates against its new defaults.

After bundling, run `node scripts/name-installers.mjs <bundle-directory>` to name
NSIS/MSI files `NearHub Cast Desktop Installer_<version>_<arch>...`. It moves
existing updater signature sidecars without changing signed package bytes.
Release preparation uses the same prefix plus full version, platform, and CPU.
