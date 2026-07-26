import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from '../src/ui/ipc.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Windows Electron shell', () => {
  it('packages only an x64 NSIS Windows target with the final app id', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const build = packageJson['build'] as Record<string, unknown>;
    const win = build['win'] as Record<string, unknown>;
    const target = win['target'] as { target: string; arch: string[] }[];

    expect(build['appId']).toBe('com.decagram.council');
    expect(target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(build['mac']).toBeUndefined();
    expect(build['linux']).toBeUndefined();
  });

  it('keeps renderer privileges isolated behind a sandboxed preload bridge', async () => {
    const main = await readFile(path.join(REPO_ROOT, 'src', 'ui', 'main.ts'), 'utf8');
    const ipc = await readFile(path.join(REPO_ROOT, 'src', 'ui', 'ipc.ts'), 'utf8');
    const ipcHandlers = await readFile(
      path.join(REPO_ROOT, 'src', 'ui', 'ipcHandlers.ts'),
      'utf8',
    );
    expect(main).toContain("process.platform !== 'win32'");
    expect(main).toContain('frame: true');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
    expect(main).toContain('app.setAppUserModelId(APP_ID)');
    expect(main).toContain('isTrustedIpcSender');
    expect(main).toContain('AgentSupervisorPort');
    expect(main).toContain('AppConfigStore');
    expect(main).toContain('acquireSingleInstance');
    expect(main).toContain("properties: ['openDirectory']");
    expect(main).toContain('registerCouncilIpc');
    expect(main).toContain('profileLoadProblem(savedRoster)');
    expect(main).toContain('profileLoadProblem(loaded)');
    expect(ipcHandlers).toContain('validateProfileId');
    expect(main).not.toContain('process.cwd()');
    expect(main).not.toContain('path.resolve(cwd)');
    expect(ipc).not.toContain("from '../integration/preflight.js'");
    expect(ipc).not.toContain('readonly executable');
    expect(ipc).not.toContain('hookConfig');
    expect(ipc).not.toContain('readonly interpreter');
  });

  it('keeps preload channel names synchronized with the typed contract', async () => {
    const preload = await readFile(path.join(REPO_ROOT, 'src', 'ui', 'preload.cjs'), 'utf8');
    for (const channel of Object.values(IPC_CHANNELS)) expect(preload).toContain(`'${channel}'`);
    expect(preload).toContain('contextBridge.exposeInMainWorld');
    expect(preload).toContain(
      'council: (question, expectedDefinitionFingerprint)',
    );
    expect(preload).toContain('chooseWorkspace: ()');
    expect(preload).toContain(
      'startNewMember: (profileId, expectedDefinitionFingerprint)',
    );
  });

  it('ships a restrictive renderer content security policy', async () => {
    const html = await readFile(
      path.join(REPO_ROOT, 'src', 'ui', 'renderer', 'index.html'),
      'utf8',
    );
    const renderer = await readFile(
      path.join(REPO_ROOT, 'src', 'ui', 'renderer', 'renderer.js'),
      'utf8',
    );
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).not.toContain('unsafe-inline');
    expect(renderer).toContain("guard.status === 'passed'");
  });

  it('recreates the pixel office locally without the prototype runtime or fixed personas', async () => {
    const html = await readFile(
      path.join(REPO_ROOT, 'src', 'ui', 'renderer', 'index.html'),
      'utf8',
    );
    const renderer = await readFile(
      path.join(REPO_ROOT, 'src', 'ui', 'renderer', 'renderer.js'),
      'utf8',
    );
    const pixelOffice = await readFile(
      path.join(REPO_ROOT, 'src', 'ui', 'renderer', 'pixel-office.js'),
      'utf8',
    );

    expect(html).toContain('id="pixel-office"');
    expect(html).toContain('src="./pixel-office.js"');
    expect(html).toContain('src="./scene-view-model.js"');
    expect(html).toContain('id="council-session"');
    expect(html).not.toContain('support.js');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(renderer).toContain('AGENTS_PER_OFFICE = 5');
    expect(renderer).toContain('snapshot?.roster.squad');
    expect(renderer).toContain('profileActions.stop(slot.member.key)');
    expect(renderer).toContain('profileActions.resume(slot.member.key)');
    expect(renderer).toContain('CouncilSceneViewModel.findCouncilSlot');
    expect(renderer).toContain('councilSlot?.validation?.fingerprint');
    expect(
      renderer.match(
        /CouncilSceneViewModel\.invokeProfileStart\(slot, profileActions\)/g,
      ),
    ).toHaveLength(2);
    expect(renderer).not.toContain('api.startMember(');
    expect(renderer).not.toContain('.innerHTML');
    expect(renderer).not.toContain('arden:');
    expect(renderer).not.toContain('bram:');
    expect(pixelOffice).toContain("type: 'agent'");
    expect(pixelOffice).toContain("type: 'room'");
    expect(pixelOffice).not.toContain('new Function');
    expect(pixelOffice).not.toContain('fetch(');
  });
});
