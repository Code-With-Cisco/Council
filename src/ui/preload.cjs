'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = {
  getState: 'dc:get-state',
  startMember: 'dc:start-member',
  stopSession: 'dc:stop-session',
  wakeSquad: 'dc:wake-squad',
  logs: 'dc:logs',
  reply: 'dc:reply',
  council: 'dc:council',
  snapshot: 'dc:snapshot',
};

contextBridge.exposeInMainWorld('decagramCouncil', {
  getState: () => ipcRenderer.invoke(channels.getState),
  startMember: (key) => ipcRenderer.invoke(channels.startMember, key),
  stopSession: (id) => ipcRenderer.invoke(channels.stopSession, id),
  wakeSquad: () => ipcRenderer.invoke(channels.wakeSquad),
  logs: (id) => ipcRenderer.invoke(channels.logs, id),
  reply: (id, message) => ipcRenderer.invoke(channels.reply, id, message),
  council: (question) => ipcRenderer.invoke(channels.council, question),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on(channels.snapshot, handler);
    return () => ipcRenderer.removeListener(channels.snapshot, handler);
  },
});
