// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createRuntimeVersionBand } from '../../src/views/runtime-version';

describe('runtime version display', () => {
  it('uses host and service versions instead of the public APK bulletin', async () => {
    const band = createRuntimeVersionBand({
      app: async () => ({ version: '3.1.2', build: '30012' }),
      cloud: async () => ({ android: { versionName: '2.6.4', versionCode: 21604, downloadUrl: '/dl/latest/android' },
        service: { buildId: 'deployment-fixture', deployedAt: '2026-10-07' } })
    });
    await band.refresh();
    expect(band.wrap.textContent).toContain('3.1.2');
    expect(band.wrap.textContent).toContain('30012');
    expect(band.wrap.textContent).toContain('deployment-fixture');
    expect(band.wrap.textContent).not.toContain('2.6.4');
  });
  it('reports unknown versions when the respective reads fail', async () => {
    const band = createRuntimeVersionBand({
      app: async () => { throw new Error('host unavailable'); },
      cloud: async () => { throw new Error('offline'); }
    });
    await band.refresh();
    expect(band.wrap.textContent).toContain('未能读取');
    expect(band.wrap.textContent).toContain('未确认');
  });
});
