export class LauncherWebCastSenderAdapter {
  constructor({launcher, touchback} = {}) {
    if (!launcher || typeof launcher.connect !== 'function' || typeof launcher.stop !== 'function') throw new TypeError('Launcher WebCast facade required');
    if (!touchback || typeof touchback.attachControlChannel !== 'function' || typeof touchback.fence !== 'function') throw new TypeError('Touchback sender required');
    this.launcher = launcher;
    this.touchback = touchback;
    this.connected = false;
  }
  async connect({pairCode, authorized = false, protocol = 'webcast'} = {}) {
    if (!pairCode || !authorized || protocol !== 'webcast') return false;
    await this.launcher.connect({pairCode, onControlChannel: channel => {
      this.connected = this.touchback.attachControlChannel(channel, {authorized, protocol});
    }});
    return this.connected;
  }
  async stop() {
    this.touchback.fence();
    this.connected = false;
    await this.launcher.stop();
  }
}
