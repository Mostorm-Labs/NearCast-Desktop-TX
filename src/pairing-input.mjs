// Read-only DOM cells prevent WebView2 from hosting an IME composition buffer.
// Keyboard and paste handlers own the value; maxlength alone does not limit
// uncommitted composition text. Never change the system-wide keyboard layout.
export function mountPairingInput({inputs,help,onChange=()=>{}}){
  const normal='请输入 4 位英文字母或数字，每格一位。';
  const valid=text=>/^[A-Z0-9]$/.test(text);
  const values=inputs.map(input=>valid(input.value)?input.value:'');
  const composing=new Set();
  const render=index=>{inputs[index].value=values[index];};
  const write=(index,value)=>{values[index]=value;render(index);};
  const focus=index=>{inputs[index].focus();inputs[index].select();};
  const changed=()=>{help.textContent=normal;onChange();};
  inputs.forEach((input,index)=>{
    input.readOnly=true;input.maxLength=1;input.pattern='[A-Z0-9]';
    input.setAttribute('inputmode','url');input.setAttribute('lang','en');
    input.setAttribute('autocapitalize','characters');input.setAttribute('autocorrect','off');
    input.spellcheck=false;render(index);
    input.addEventListener('beforeinput',event=>{event.preventDefault();render(index);});
    // Reject browser/autofill and synthetic mutation paths immediately too.
    input.addEventListener('input',()=>render(index));
    input.addEventListener('compositionstart',()=>{composing.add(input);render(index);});
    input.addEventListener('compositionupdate',()=>render(index));
    input.addEventListener('compositionend',()=>{composing.delete(input);render(index);});
    input.addEventListener('blur',()=>{composing.delete(input);render(index);});
    input.addEventListener('keydown',event=>{
      if(input.disabled)return;
      if(event.isComposing||composing.has(input)||event.keyCode===229){
        event.preventDefault();render(index);return;
      }
      // Read-only cells still receive native paste events in WebView2.
      if(event.ctrlKey||event.metaKey||event.altKey)return;
      if(/^[a-z0-9]$/i.test(event.key)){
        event.preventDefault();if(event.repeat)return;
        write(index,event.key.toUpperCase());changed();focus(Math.min(index+1,inputs.length-1));
      }else if(event.key==='Backspace'){
        event.preventDefault();
        if(values[index])write(index,'');else if(index>0){write(index-1,'');focus(index-1);}changed();
      }else if(event.key==='Delete'){
        event.preventDefault();write(index,'');changed();
      }else if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
        event.preventDefault();focus(event.key==='Home'?0:event.key==='End'?inputs.length-1:Math.max(0,Math.min(inputs.length-1,index+(event.key==='ArrowLeft'?-1:1))));
      }else if(event.key.length===1){event.preventDefault();render(index);}
    });
    input.addEventListener('paste',event=>{
      event.preventDefault();if(input.disabled||composing.has(input))return;
      const text=(event.clipboardData?.getData('text')??'').trim().toUpperCase();
      if(!/^[A-Z0-9]+$/.test(text)||text.length>inputs.length-index){
        help.textContent='请粘贴不超过 4 位的英文字母或数字配对码。';render(index);return;
      }
      [...text].forEach((char,offset)=>write(index+offset,char));
      changed();focus(Math.min(index+text.length,inputs.length-1));
    });
  });
  help.textContent=normal;
  return{clear(){values.fill('');inputs.forEach((_,index)=>render(index));composing.clear();help.textContent=normal;}};
}
