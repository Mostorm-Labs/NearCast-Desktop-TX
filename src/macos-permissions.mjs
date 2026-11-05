const PERMISSIONS = Object.freeze([
  {id: 'localNetwork', title: '本地网络', help: '发现和连接接收端；在系统设置中选择“本地网络”'},
  {id: 'screenRecording', title: '录屏与系统录音', help: '分享所选屏幕的画面'},
  {id: 'accessibility', title: '辅助功能', help: '允许接收端控制鼠标'},
]);

export class MacOsPermissions {
  constructor({invoke} = {}) {
    this.invoke = invoke;
    this.snapshot = {};
    this.pending = null;
  }

  rows() {
    return PERMISSIONS.map(permission => {
      const value = this.snapshot?.[permission.id];
      const enabled = permission.id === 'localNetwork'
        ? (value === 'available' ? true : null)
        : value === 'granted' ? true : value === 'not_granted' ? false : null;
      const status = enabled === null ? '待确认' : permission.id === 'localNetwork' ? '网络可用' : enabled ? '已开启' : '未开启';
      return {...permission, enabled, status};
    });
  }

  refresh() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.invoke('nearcast_macos_permissions'))
      .then(snapshot => { this.snapshot = snapshot ?? {}; return this.rows(); })
      .catch(error => { this.snapshot = {}; throw error; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async openSettings(permission) {
    if (!PERMISSIONS.some(item => item.id === permission)) throw new RangeError('Unknown macOS permission');
    await this.invoke('nearcast_macos_permission_settings', {permission});
    return this.refresh();
  }
}
