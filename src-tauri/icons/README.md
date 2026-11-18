# Application icon

`icon.svg` is the unmodified Figma vector asset for the NearHub Cast TX application
icon: [Launcher, node 6849:1882](https://www.figma.com/design/VyCrgYgQadCLdj5nSjt0mJ/Launcher?node-id=6849-1882).

Generate the desktop assets with the repository's pinned Tauri CLI:

```powershell
node node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/icon.svg --output <temporary-directory>
```

Copy `icon.ico` and `icon.png` into this directory for Windows and the default
window icon. Generate the macOS asset separately:

```sh
node scripts/generate-macos-icon.mjs
```

This wraps the same vector artwork in a transparent 1024×1024 canvas, with an
824×824 tile centered inside it (100 px margins), then uses the pinned Tauri CLI
to generate every ICNS representation. Only `nearhub-cast.icns` is copied back.
The original full-bleed SVG/PNG/ICO are retained for the other platforms. Directly
using their full-bleed export for ICNS makes the Dock icon look larger than its
neighbors; its visible tile needs transparent margins in the ICNS itself.
Other generated platform assets are not used by this desktop application.

macOS system sharing pickers read the application bundle's
`Contents/Resources/nearhub-cast.icns`, a distinct resource name from the legacy
`icon.icns` used by older builds. Local signed builds through `npm run build:macos`
verify the signature and force-refresh the bundle's Launch Services registration
so system UI can pick up icon changes at the same development path.
The macOS startup hook also sets `NSApplication.applicationIconImage` from this
same ICNS asset, including in bundled builds where Tauri omits its dev override.
