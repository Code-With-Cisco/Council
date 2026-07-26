'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = {
  getState: 'dc:get-state',
  chooseWorkspace: 'dc:choose-workspace',
  startMember: 'dc:start-member',
  startNewMember: 'dc:start-new-member',
  resumeMember: 'dc:resume-member',
  clearBinding: 'dc:clear-binding',
  stopSession: 'dc:stop-session',
  wakeSquad: 'dc:wake-squad',
  logs: 'dc:logs',
  reply: 'dc:reply',
  council: 'dc:council',
  snapshot: 'dc:snapshot',
  state: 'dc:state',
};

contextBridge.exposeInMainWorld('decagramCouncil', {
  getState: () => ipcRenderer.invoke(channels.getState),
  chooseWorkspace: () => ipcRenderer.invoke(channels.chooseWorkspace),
  startMember: (profileId, expectedDefinitionFingerprint) =>
    ipcRenderer.invoke(
      channels.startMember,
      profileId,
      expectedDefinitionFingerprint,
    ),
  startNewMember: (profileId, expectedDefinitionFingerprint) =>
    ipcRenderer.invoke(
      channels.startNewMember,
      profileId,
      expectedDefinitionFingerprint,
    ),
  resumeMember: (profileId) => ipcRenderer.invoke(channels.resumeMember, profileId),
  clearBinding: (profileId) => ipcRenderer.invoke(channels.clearBinding, profileId),
  stopSession: (profileId) => ipcRenderer.invoke(channels.stopSession, profileId),
  wakeSquad: () => ipcRenderer.invoke(channels.wakeSquad),
  logs: (profileId) => ipcRenderer.invoke(channels.logs, profileId),
  reply: (profileId, message) => ipcRenderer.invoke(channels.reply, profileId, message),
  council: (question, expectedDefinitionFingerprint) =>
    ipcRenderer.invoke(
      channels.council,
      question,
      expectedDefinitionFingerprint,
    ),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on(channels.snapshot, handler);
    return () => ipcRenderer.removeListener(channels.snapshot, handler);
  },
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on(channels.state, handler);
    return () => ipcRenderer.removeListener(channels.state, handler);
  },
});
