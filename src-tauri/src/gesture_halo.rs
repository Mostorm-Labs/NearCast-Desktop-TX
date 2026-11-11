#[cfg(target_os="macos")]
extern "C" {
    fn nearcast_halo_show(x:f64,y:f64,stage:i32,progress:f64);
    fn nearcast_halo_clear();
}
pub fn clear(){
    #[cfg(target_os="macos")]
    unsafe{nearcast_halo_clear();}
}
pub fn show(x:f64,y:f64,stage:&str,progress:f64){
    #[cfg(target_os="macos")]
    {
        let code=match stage{"holding"=>1,"armed"=>2,"dragging"=>3,"two-finger"=>4,"pinching"=>5,"scrolling"=>6,_=>return clear()};
        unsafe{nearcast_halo_show(x,y,code,progress);}
    }
    #[cfg(not(target_os="macos"))]
    let _=(x,y,stage,progress);
}
