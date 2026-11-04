import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the packaged module too: the desktop app loads dist directly.
for (const location of ['../src/macos-permissions.mjs', '../dist/macos-permissions.mjs']) {
  const {MacOsPermissions} = await import(location);

  test(`${location}: reads native authorization and keeps network availability distinct`, async () => {
    const permissions = new MacOsPermissions({invoke: async command => {
      assert.equal(command, 'nearcast_macos_permissions');
      return {localNetwork: 'available', screenRecording: 'not_granted', accessibility: 'granted'};
    }});
    const rows = await permissions.refresh();
    assert.deepEqual(rows.map(({id, enabled}) => [id, enabled]), [
      ['localNetwork', true], ['screenRecording', false], ['accessibility', true],
    ]);
    assert.equal(rows[0].status, '网络可用');
    assert.equal(rows[1].status, '未开启');
  });

  test(`${location}: an opened settings page never grants permission by itself`, async () => {
    let granted = false;
    const calls = [];
    const permissions = new MacOsPermissions({invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'nearcast_macos_permission_settings') return null;
      return {localNetwork: 'unknown', screenRecording: granted ? 'granted' : 'not_granted', accessibility: 'not_granted'};
    }});
    await permissions.refresh();
    await permissions.openSettings('screenRecording');
    assert.deepEqual(calls[1], ['nearcast_macos_permission_settings', {permission: 'screenRecording'}]);
    assert.equal(permissions.rows()[1].enabled, false);
    granted = true; // A later native check observes the change made in System Settings.
    await permissions.refresh();
    assert.equal(permissions.rows()[1].enabled, true);
  });

  test(`${location}: failed or unrecognized checks show unknown instead of stale authorization`, async () => {
    let fail = false;
    const permissions = new MacOsPermissions({invoke: async () => {
      if (fail) throw new Error('native unavailable');
      return {localNetwork: 'granted', screenRecording: 'granted', accessibility: 'unexpected'};
    }});
    await permissions.refresh();
    assert.equal(permissions.rows()[0].enabled, null);
    assert.equal(permissions.rows()[2].enabled, null);
    fail = true;
    await assert.rejects(permissions.refresh(), /native unavailable/);
    assert.ok(permissions.rows().every(row => row.enabled === null));
  });

  test(`${location}: refuses arbitrary settings destinations without calling native code`, async () => {
    const permissions = new MacOsPermissions({invoke: async () => assert.fail('invalid permission reached native code')});
    for (const permission of ['camera', 'https://example.com', '', '__proto__']) {
      await assert.rejects(permissions.openSettings(permission), /Unknown macOS permission/);
    }
  });

  test(`${location}: shares an in-flight status check between simultaneous refreshes`, async () => {
    let resolveCheck;
    let count = 0;
    const permissions = new MacOsPermissions({invoke: () => {
      count++;
      return new Promise(resolve => { resolveCheck = resolve; });
    }});
    const first = permissions.refresh();
    const second = permissions.refresh();
    await Promise.resolve();
    resolveCheck({localNetwork: 'available', screenRecording: 'granted', accessibility: 'granted'});
    await Promise.all([first, second]);
    assert.equal(count, 1);
    assert.ok(permissions.rows().every(row => row.enabled === true));
  });
}
