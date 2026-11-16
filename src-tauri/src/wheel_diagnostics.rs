use serde::{Deserialize,Serialize};
use std::sync::Mutex;

#[derive(Clone,Default,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct WheelTotals {
    pub events:u64,pub positive_x:u64,pub negative_x:u64,pub positive_y:u64,pub negative_y:u64,
}
static TOTALS:Mutex<WheelTotals>=Mutex::new(WheelTotals{events:0,positive_x:0,negative_x:0,positive_y:0,negative_y:0});
#[cfg(windows)]
pub fn submitted(horizontal:bool,delta:i32){
    if let Ok(mut totals)=TOTALS.lock(){
        totals.events=totals.events.saturating_add(1);
        let value=if horizontal {if delta>=0{&mut totals.positive_x}else{&mut totals.negative_x}}
            else if delta>=0{&mut totals.positive_y}else{&mut totals.negative_y};
        *value=value.saturating_add(i64::from(delta).unsigned_abs());
    }
}
pub fn snapshot()->WheelTotals{TOTALS.lock().map(|t|t.clone()).unwrap_or_default()}

#[cfg(test)]
mod tests{
    #[test]
    fn signed_axes_serialize_without_cancelling(){
        let value=super::WheelTotals{events:2,positive_y:120,negative_y:240,..Default::default()};
        let json=serde_json::to_value(value).unwrap();assert_eq!(json["positiveY"],120);assert_eq!(json["negativeY"],240);
    }
}
