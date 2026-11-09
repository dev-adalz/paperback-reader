// Narrow bridge between the page and the on-disk library (main process).
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('paperback', {
  info: call('lib:info'),
  chooseFolder: call('lib:choose'),
  scan: call('lib:scan'),
  add: call('lib:add'),
  upsert: call('lib:upsert'),
  ignore: call('lib:ignore'),
  read: call('lib:read'),
  remove: call('lib:remove'),
  reveal: call('lib:reveal'),
  categories: call('lib:categories'),
  setCategory: call('lib:setCategory'),
  /** Called when files in books/ were added, changed or removed outside the app. */
  download: call('book:download'),
  cancelDownload: call('book:download:cancel'),
  /** Progress for book:download. Returns an unsubscribe function. */
  onDownloadProgress(cb) {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('book:download-progress', listener);
    return () => ipcRenderer.removeListener('book:download-progress', listener);
  },
  
  onChange(cb) {
    const listener = () => cb();
    ipcRenderer.on('lib:changed', listener);
    return () => ipcRenderer.removeListener('lib:changed', listener);
  },
});
