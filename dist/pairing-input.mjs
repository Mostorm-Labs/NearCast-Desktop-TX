// Accept direct ASCII input only. Composition never advances focus or spreads
// phonetic input across cells. Do not change the system-wide keyboard layout.
export function mountPairingInput({inputs,help,onChange=()=>{}}){
  const normal='请输入 4 位英文字母或数字，请使用英文输入法。';
  const ascii=text=>/^[a-z0-9]+$/i.test(text);
  inputs.forEach((input,index)=>{
    let composing=false,previous='',ignoreCommit=false;
    input.setAttribute('inputmode','url');input.setAttribute('lang','en');
    input.setAttribute('autocapitalize','characters');input.setAttribute('autocorrect','off');input.spellcheck=false;
    input.addEventListener('compositionstart',()=>{composing=true;previous=input.value;});
    input.addEventListener('compositionend',()=>{
      composing=false;input.value=previous;ignoreCommit=true;
      help.textContent='请切换英文输入法，仅支持 A–Z 和 0–9。';
      setTimeout(()=>{ignoreCommit=false;},0);
    });
    input.addEventListener('beforeinput',event=>{
      if(event.isComposing||composing||/Composition/.test(event.inputType??'')){
        if(event.cancelable)event.preventDefault();return;
      }
      if(event.inputType?.startsWith('insert')&&event.data!==null&&!ascii(event.data)){
        event.preventDefault();help.textContent='仅支持英文字母和数字，请使用英文输入法。';
      }
    });
    input.addEventListener('input',event=>{
      if(composing||event.isComposing)return;
      if(ignoreCommit||/Composition/.test(event.inputType??'')){input.value=previous;return;}
      // A direct keystroke can fill one cell. Multi-character IME commits are
      // rejected; pasting a complete code has its own explicit path below.
      if(!ascii(input.value)||input.value.length!==1){input.value='';return;}
      input.value=input.value.toUpperCase();previous=input.value;help.textContent=normal;onChange();
      inputs[Math.min(index+1,inputs.length-1)].focus();
    });
    input.addEventListener('keydown',event=>{
      if(event.isComposing||composing||event.keyCode===229)return;
      if(event.key==='Backspace'&&!input.value&&index>0)inputs[index-1].focus();
    });
    input.addEventListener('paste',event=>{
      event.preventDefault();if(composing)return;
      const text=(event.clipboardData?.getData('text')??'').trim();
      if(!ascii(text)||text.length>inputs.length-index){help.textContent='请粘贴不超过 4 位的英文字母或数字配对码。';return;}
      [...text.toUpperCase()].forEach((char,offset)=>{inputs[index+offset].value=char;});
      help.textContent=normal;onChange();inputs[Math.min(index+text.length,inputs.length-1)].focus();
    });
  });
}
