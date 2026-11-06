#![cfg(windows)]
use windows::Win32::{
    Foundation::HMODULE,
    Graphics::{Direct3D::D3D_DRIVER_TYPE_WARP, Direct3D11::*, Dxgi::Common::*},
};
fn texture(device: &ID3D11Device, width: u32, height: u32, color: [u8; 4]) -> ID3D11Texture2D {
    let pixels = color.repeat((width * height) as usize);
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        ..Default::default()
    };
    let data = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast(),
        SysMemPitch: width * 4,
        ..Default::default()
    };
    let mut result = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut result)) }.unwrap();
    result.unwrap()
}
#[test]
fn readback_updates_pixels_when_pool_surface_changes_without_content_resize() {
    // WARP exercises the real D3D resource-copy contract without requiring a GPU on CI.
    let (mut device, mut context) = (None, None);
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_WARP,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .unwrap();
    let (device, context) = (device.unwrap(), context.unwrap());
    let mut staging = None;
    let first = texture(&device, 8, 8, [0x11, 0x22, 0x33, 255]);
    assert_eq!(
        super::copy_texture(&device, &context, &mut staging, &first, 4, 4).unwrap(),
        [0x11, 0x22, 0x33, 255].repeat(16)
    );
    let next = texture(&device, 4, 4, [0xaa, 0xbb, 0xcc, 255]);
    assert_eq!(
        super::copy_texture(&device, &context, &mut staging, &next, 4, 4).unwrap(),
        [0xaa, 0xbb, 0xcc, 255].repeat(16),
        "readback must not silently retain the previous surface pixels"
    );
    let wider = texture(&device, 12, 6, [0x44, 0x55, 0x66, 255]);
    assert_eq!(
        super::copy_texture(&device, &context, &mut staging, &wider, 4, 4).unwrap(),
        [0x44, 0x55, 0x66, 255].repeat(16)
    );
    assert!(
        super::copy_texture(&device, &context, &mut staging, &next, 8, 8)
            .unwrap()
            .is_empty(),
        "transitional undersized surfaces must never be read outside their bounds"
    );
}
