pub fn fit_size(width: i32, height: i32) -> Result<(usize, usize), String> {
    if width <= 0
        || height <= 0
        || width > 16384
        || height > 16384
        || (width as i64) * (height as i64) > 3840 * 2160
    {
        return Err("thumbnail_source_size_invalid".into());
    }
    let scale = (320.0 / width as f64).min(180.0 / height as f64).min(1.0);
    Ok((
        ((width as f64) * scale).floor().max(1.0) as usize,
        ((height as f64) * scale).floor().max(1.0) as usize,
    ))
}
pub fn encode_bgra_bmp(source: &[u8], width: i32, height: i32) -> Result<Vec<u8>, String> {
    let (w, h) = fit_size(width, height)?;
    if source.len() != width as usize * height as usize * 4 {
        return Err("thumbnail_source_length_invalid".into());
    }
    let mut image = vec![0u8; 54 + w * h * 4];
    let length = image.len() as u32;
    image[..2].copy_from_slice(b"BM");
    image[2..6].copy_from_slice(&length.to_le_bytes());
    image[10..14].copy_from_slice(&54u32.to_le_bytes());
    image[14..18].copy_from_slice(&40u32.to_le_bytes());
    image[18..22].copy_from_slice(&(w as i32).to_le_bytes());
    image[22..26].copy_from_slice(&(-(h as i32)).to_le_bytes());
    image[26..28].copy_from_slice(&1u16.to_le_bytes());
    image[28..30].copy_from_slice(&32u16.to_le_bytes());
    image[34..38].copy_from_slice(&((w * h * 4) as u32).to_le_bytes());
    for y in 0..h {
        for x in 0..w {
            let from = ((y * height as usize / h) * width as usize + x * width as usize / w) * 4;
            let to = 54 + (y * w + x) * 4;
            image[to..to + 3].copy_from_slice(&source[from..from + 3]);
            image[to + 3] = 255;
        }
    }
    Ok(image)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thumbnail_fits_without_stretching_or_upscaling() {
        assert_eq!(fit_size(1920, 1080).unwrap(), (320, 180));
        assert_eq!(fit_size(800, 600).unwrap(), (240, 180));
        assert_eq!(fit_size(2, 2).unwrap(), (2, 2));
        assert!(fit_size(0, 1080).is_err());
        assert!(fit_size(100000, 100000).is_err());
    }
    #[test]
    fn bmp_thumbnail_preserves_bgra_rows_and_has_a_bounded_top_down_header() {
        let source = [3, 2, 1, 0, 6, 5, 4, 0, 9, 8, 7, 0, 12, 11, 10, 0];
        let image = encode_bgra_bmp(&source, 2, 2).unwrap();
        assert_eq!(&image[..2], b"BM");
        assert_eq!(image.len(), 70);
        assert_eq!(u32::from_le_bytes(image[10..14].try_into().unwrap()), 54);
        assert_eq!(i32::from_le_bytes(image[22..26].try_into().unwrap()), -2);
        assert_eq!(
            &image[54..],
            [3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]
        );
        assert!(encode_bgra_bmp(&source[..15], 2, 2).is_err());
    }
}
