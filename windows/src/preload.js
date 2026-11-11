// 패널 화면에 열어 주는 좁은 통로. 화면은 동작 이름만 보내고 앱 상태(view)를 받는다.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitbell', {
  init: () => ipcRenderer.invoke('init'),
  action: (name, ...args) => ipcRenderer.invoke('action', name, ...args),
  resize: (height) => ipcRenderer.send('resize', height),
  sendTrayImage: (images) => ipcRenderer.send('tray-image', images),
  onView: (callback) => ipcRenderer.on('view', (_event, view) => callback(view)),
  onDrawTray: (callback) => ipcRenderer.on('draw-tray', (_event, request) => callback(request)),
  onShown: (callback) => ipcRenderer.on('shown', (_event, maxHeight, options) => callback(maxHeight, options || {})),
});
