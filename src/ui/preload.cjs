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
  recoverSupervisor: 'dc:recover-supervisor',
  logs: 'dc:logs',
  reply: 'dc:reply',
  council: 'dc:council',
  getMissionState: 'dc:mission:get-state',
  createMission: 'dc:mission:create',
  previewSquad: 'dc:mission:preview-squad',
  startSquad: 'dc:mission:start-squad',
  retryMissionExecution: 'dc:mission:retry-execution',
  recordHandoff: 'dc:mission:record-handoff',
  createCandidate: 'dc:mission:create-candidate',
  recordGate: 'dc:mission:record-gate',
  previewIntegration: 'dc:mission:preview-integration',
  approveIntegration: 'dc:mission:approve-integration',
  rejectIntegration: 'dc:mission:reject-integration',
  missionState: 'dc:mission:state',
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
  recoverSupervisor: () => ipcRenderer.invoke(channels.recoverSupervisor),
  logs: (profileId) => ipcRenderer.invoke(channels.logs, profileId),
  reply: (profileId, message) => ipcRenderer.invoke(channels.reply, profileId, message),
  council: (question, expectedDefinitionFingerprint) =>
    ipcRenderer.invoke(
      channels.council,
      question,
      expectedDefinitionFingerprint,
    ),
  getMissionState: () => ipcRenderer.invoke(channels.getMissionState),
  createMission: (input) => ipcRenderer.invoke(channels.createMission, input),
  previewSquad: (input) => ipcRenderer.invoke(channels.previewSquad, input),
  startSquad: (previewDigest) =>
    ipcRenderer.invoke(channels.startSquad, previewDigest),
  retryMissionExecution: (input) =>
    ipcRenderer.invoke(channels.retryMissionExecution, input),
  recordHandoff: (input) => ipcRenderer.invoke(channels.recordHandoff, input),
  createCandidate: (input) =>
    ipcRenderer.invoke(channels.createCandidate, input),
  recordGate: (input) => ipcRenderer.invoke(channels.recordGate, input),
  previewIntegration: (input) =>
    ipcRenderer.invoke(channels.previewIntegration, input),
  approveIntegration: (previewDigest) =>
    ipcRenderer.invoke(channels.approveIntegration, previewDigest),
  rejectIntegration: (previewDigest) =>
    ipcRenderer.invoke(channels.rejectIntegration, previewDigest),
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
  onMissionState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on(channels.missionState, handler);
    return () => ipcRenderer.removeListener(channels.missionState, handler);
  },
});
