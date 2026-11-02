const isPin = value => typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
export function formatFingerprint(value) {
  if (!isPin(value)) throw new TypeError('完整设备指纹无效');
  return value.match(/.{16}/g).map(line => line.match(/.{4}/g).join(' ')).join('\n');
}

export class ReceiverTrust {
  constructor({invoke, onChange = () => {}, onTrusted = () => {}, now = () => Date.now()} = {}) {
    this.invoke = invoke; this.onChange = onChange; this.onTrusted = onTrusted; this.now = now;
    this.state = {phase:'idle'}; this.device = null; this.generation = 0; this.timer = null;
  }
  update(phase, values = {}) { this.state = {phase,device:this.device,...values}; this.onChange(this.state); }
  cancel() {
    this.generation++; clearTimeout(this.timer); this.timer = null; this.device = null; this.update('idle');
    return Promise.resolve(this.invoke('nearcast_trust_cancel',{})).catch(()=>{});
  }
  validDevice() { return this.device?.protocol === 'webcast' && this.device.selectable && typeof this.device.deviceId === 'string' && this.device.expiresAt > this.now(); }
  async select(device) {
    const cancelling = this.cancel(); const generation = this.generation;
    await cancelling;
    if (generation !== this.generation) return;
    this.device = device;
    if (!this.validDevice()) { this.update('error',{error:'接收端已离线，请重新扫描。'}); return; }
    this.update('checking');
    try {
      const saved = await this.invoke('nearcast_trust_status',{deviceId:device.deviceId});
      if (generation !== this.generation) return;
      if (saved?.trusted === true && saved.deviceId === device.deviceId && isPin(saved.fingerprint)) {
        this.update('trusted',{fingerprint:saved.fingerprint}); this.onTrusted(device); return;
      }
      await this.prepare();
      if (generation !== this.generation) return;
    } catch(error) { if (generation === this.generation) this.update('error',{error:error.message || String(error)}); }
  }
  async prepare() {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    if (!this.validDevice()) { this.update('error',{error:'接收端已离线，请重新扫描。'}); return; }
    if (!this.device.supportsTrustDisplay) { this.update('unsupported'); return; }
    this.update('preparing');
    try {
      const candidate = await this.invoke('nearcast_trust_prepare',{instance:this.device.instance,deviceId:this.device.deviceId});
      if (generation !== this.generation) return;
      if (!this.validDevice() || candidate?.deviceId !== this.device.deviceId || typeof candidate.candidateId !== 'string' || !isPin(candidate.fingerprint) || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= this.now()) throw new Error('指纹核对已过期，请重新显示指纹。');
      this.update('compare',{...candidate});
      clearTimeout(this.timer);
      this.timer = setTimeout(()=>{ if (generation === this.generation) this.update('expired'); },Math.min(60000,candidate.expiresAt-this.now()));
    } catch(error) { if (generation === this.generation) this.update('error',{error:error.message || String(error)}); }
  }
  async confirm(compared) {
    const candidate = this.state; const generation = this.generation;
    if (!compared || candidate.phase !== 'compare' || candidate.expiresAt <= this.now() || !this.validDevice()) throw new Error('请先逐组现场核对完整指纹；核对过期后需重新显示。');
    this.update('saving',{...candidate,phase:'saving'});
    try {
      await this.invoke('nearcast_trust_confirm',{deviceId:this.device.deviceId,candidateId:candidate.candidateId,fingerprint:candidate.fingerprint});
      if (generation !== this.generation) return;
      clearTimeout(this.timer); this.update('trusted',{fingerprint:candidate.fingerprint}); this.onTrusted(this.device);
    } catch(error) { if (generation === this.generation) this.update('error',{error:error.message || String(error)}); }
  }
  keyMismatch(error) { clearTimeout(this.timer); this.update('changed',{error:String(error),fingerprint:this.state.fingerprint}); }
  async revoke() {
    if (!this.device) return;
    const generation = this.generation;
    await this.invoke('nearcast_trust_revoke',{deviceId:this.device.deviceId});
    if (generation !== this.generation) return;
    clearTimeout(this.timer); this.update('untrusted');
  }
}
