#[cfg(target_os="macos")]
extern "C" {
    fn nearcast_halo_show(x:f64,y:f64,stage:i32,progress:f64);
    fn nearcast_halo_clear();
}
pub fn clear(){
    #[cfg(target_os="macos")]
    unsafe{nearcast_halo_clear();}
}
#[cfg(any(target_os="macos",test))]
fn stage_code(stage:&str)->Option<i32>{
    match stage{"holding"=>Some(1),"armed"=>Some(2),"dragging"=>Some(3),"two-finger"=>Some(4),"pinching"=>Some(5),"scrolling"=>Some(6),
        "right-wait"=>Some(7),"right-ready"=>Some(8),"released"=>Some(9),"right-released"=>Some(10),_=>None}
}
pub fn show(x:f64,y:f64,stage:&str,progress:f64){
    #[cfg(target_os="macos")]
    {
        let Some(code)=stage_code(stage)else{return clear()};
        unsafe{nearcast_halo_show(x,y,code,progress);}
    }
    #[cfg(not(target_os="macos"))]
    let _=(x,y,stage,progress);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hold_right_and_release_feedback_select_distinct_native_visuals() {
        assert_eq!(stage_code("right-wait"),Some(7));
        assert_eq!(stage_code("right-ready"),Some(8));
        assert_eq!(stage_code("released"),Some(9));
        assert_eq!(stage_code("right-released"),Some(10));
        assert_eq!(stage_code("unknown"),None);
    }
}
