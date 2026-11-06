use serde::Deserialize;
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Point {
    pub contact_id: u16,
    pub x: i32,
    pub y: i32,
    pub phase: u8,
    pub submitted: bool,
    pub expires_in_ms: Option<u16>,
}
#[cfg(any(windows, test))]
#[derive(Default)]
pub struct Scene {
    pub owner_id: String,
    serial: u64,
    revision: String,
    marks: Vec<(Point, Option<u64>)>,
}
#[cfg(any(windows, test))]
impl Scene {
    pub fn replace(
        &mut self,
        serial: u64,
        revision: &str,
        owner: &str,
        points: Vec<Point>,
        now: u64,
    ) -> Result<bool, String> {
        if serial <= self.serial {
            return Ok(false);
        }
        let mut ids = std::collections::HashSet::new();
        if serial == 0
            || revision.len() > 128
            || owner.len() > 128
            || points.len() > 32
            || (!points.is_empty() && (revision.is_empty() || owner.is_empty()))
            || points.iter().any(|p| {
                !ids.insert(p.contact_id)
                    || p.phase > 3
                    || if p.phase >= 2 {
                        !p.expires_in_ms.is_some_and(|ms| ms > 0 && ms <= 1000)
                    } else {
                        p.expires_in_ms.is_some()
                    }
            })
        {
            return Err("touch_feedback_invalid_scene".into());
        }
        self.serial = serial;
        self.revision = revision.into();
        self.owner_id = owner.into();
        self.marks = points
            .into_iter()
            .map(|point| {
                let expires = point.expires_in_ms.map(|ms| now + ms as u64);
                (point, expires)
            })
            .collect();
        Ok(true)
    }
    pub fn visible(&mut self, revision: &str, ready: bool, now: u64) -> Vec<Point> {
        if !ready || self.revision != revision {
            self.marks.clear();
        }
        self.marks
            .retain(|(_, until)| until.is_none_or(|until| until > now));
        self.marks.iter().map(|(point, _)| point.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn point() -> Point {
        Point {
            contact_id: 1,
            x: -1800,
            y: 120,
            phase: 0,
            submitted: false,
            expires_in_ms: None,
        }
    }
    #[test]
    fn scenes_fence_old_ipc_expire_pulses_and_clear_when_geometry_is_lost() {
        let mut scene = Scene::default();
        scene.replace(1, "r1", "owner", vec![point()], 0).unwrap();
        assert_eq!(scene.visible("r1", true, 0)[0].x, -1800);
        let mut done = point();
        done.phase = 2;
        done.submitted = true;
        done.expires_in_ms = Some(700);
        scene.replace(3, "r1", "owner", vec![done], 10).unwrap();
        assert!(!scene.replace(2, "r1", "owner", vec![point()], 11).unwrap());
        assert!(scene.visible("r1", true, 11)[0].submitted);
        assert!(scene.visible("r1", true, 710).is_empty());
        scene.replace(4, "r1", "owner", vec![point()], 800).unwrap();
        assert!(scene.visible("r2", true, 800).is_empty());
        assert!(scene.visible("r1", true, 801).is_empty());
        scene.replace(5, "r1", "owner", vec![point()], 900).unwrap();
        assert!(scene.visible("r1", false, 901).is_empty());
    }
    #[test]
    fn malformed_scenes_are_atomic_and_bounded() {
        let mut scene = Scene::default();
        scene.replace(1, "r1", "owner", vec![point()], 0).unwrap();
        assert!(scene
            .replace(2, "r1", "owner", vec![point(); 33], 0)
            .is_err());
        let mut bad = point();
        bad.phase = 4;
        assert!(scene.replace(2, "r1", "owner", vec![bad], 0).is_err());
        assert_eq!(scene.visible("r1", true, 0).len(), 1);
    }
}
