# Application icon

`icon.svg` is the unmodified Figma vector asset for the NearHub Cast TX application
icon: [Launcher, node 6849:1882](https://www.figma.com/design/VyCrgYgQadCLdj5nSjt0mJ/Launcher?node-id=6849-1882).

Generate the desktop assets with the repository's pinned Tauri CLI:

```powershell
node node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/icon.svg --output <temporary-directory>
```

Copy `icon.ico`, `icon.icns`, and `icon.png` into this directory. These are the
Windows, macOS, and default window icons configured in `tauri.conf.json`.
Other generated platform assets are not used by this desktop application.
