import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openPacks:     (): void                          => ipcRenderer.send('open-packs'),
  openAddSound:  (): void                          => ipcRenderer.send('open-add-sound'),
  openSettings:  (): void                          => ipcRenderer.send('open-settings'),
  openBoard:     (): void                          => ipcRenderer.send('open-board'),
  closeWindow:   (): void                          => ipcRenderer.send('close-window'),
  setVolume:     (v: number): void                 => ipcRenderer.send('set-volume', v),
  saveSetting:   (key: string, val: unknown): void => ipcRenderer.send('save-setting', key, val),
  getSetting:    (key: string, fb: unknown): Promise<unknown>  => ipcRenderer.invoke('get-setting', key, fb),
  getAllSettings:  (): Promise<Record<string, unknown>>          => ipcRenderer.invoke('get-all-settings'),
  appVersion:    (): Promise<string>               => ipcRenderer.invoke('app-version'),
  settingsExport: (): Promise<{ ok: boolean; file?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('settings-export'),
  settingsReset:  (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('settings-reset'),
  checkAccessibility:   (): Promise<boolean>       => ipcRenderer.invoke('check-accessibility'),
  requestAccessibility: (): Promise<boolean>       => ipcRenderer.invoke('request-accessibility'),

  // ── Packs ────────────────────────────────────────────────────────────────
  selectPack:      (packId: string): void                       => ipcRenderer.send('select-pack', packId),
  getPacks:        (): Promise<Array<{
    id: string; name: string; description: string;
    origin: 'bundled' | 'user';
    keys: Record<string, { label: string; file: string; url: string; source: 'bundled' | 'user' | 'recording' }>;
  }>> => ipcRenderer.invoke('get-packs'),
  packCreate:      (opts: { name: string; description?: string; id?: string }):
    Promise<{ ok: boolean; id?: string; name?: string; error?: string }> =>
    ipcRenderer.invoke('pack-create', opts),
  packDelete:      (packId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pack-delete', packId),
  packBindSound:   (opts: { packId: string; key: string; recordingId?: string; label?: string }):
    Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pack-bind-sound', opts),
  packUnbindKey:   (packId: string, key: string):
    Promise<{ ok: boolean; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke('pack-unbind-key', packId, key),

  // ── YouTube clips → library ─────────────────────────────────────────────
  ytInfo:          (url: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('yt-info', url),
  ytPrepareClip:   (opts: { url: string; start: number; end: number }):
    Promise<{ ok: boolean; cachePath?: string; url?: string; cached?: boolean; error?: string }> =>
    ipcRenderer.invoke('yt-prepare-clip', opts),
  libraryAddFromClip: (opts: { cachePath: string; name: string; sourceUrl?: string; durationMs?: number }):
    Promise<{ ok: boolean; item?: { id: string; name: string; url: string }; error?: string }> =>
    ipcRenderer.invoke('library-add-from-clip', opts),

  ytDetectSnippets: (url: string):
    Promise<{
      ok: boolean;
      result?:
        | { kind: 'playlist';  items:    Array<{ videoId: string; title: string; duration?: number }>; meta: { title: string; thumbnail: string; duration?: number } }
        | { kind: 'chapters';  chapters: Array<{ title: string; start: number; end: number }>;          meta: { title: string; thumbnail: string; duration?: number } }
        | { kind: 'none';      meta: { title: string; thumbnail: string; duration?: number } };
      error?: string;
    }> =>
    ipcRenderer.invoke('yt-detect-snippets', url),

  ytPreparePack: (opts: { url: string; segments: Array<{ title: string; start: number; end: number }> }):
    Promise<{
      ok: boolean;
      prepared?: Array<{ title: string; cachePath: string; durationMs: number }>;
      failed?:   Array<{ title: string; error: string }>;
      error?: string;
    }> =>
    ipcRenderer.invoke('yt-prepare-pack', opts),

  libraryCreatePackFromClips: (opts: {
    url: string;
    packName: string;
    clips: Array<{ cachePath: string; title: string; durationMs: number }>;
  }):
    Promise<{ ok: boolean; packId?: string; finalName?: string; keysAssigned?: number; error?: string }> =>
    ipcRenderer.invoke('library-create-pack-from-clips', opts),

  // ── Library inventory (mic recordings + youtube clips) ──────────────────
  recordingSave:   (opts: { name: string; buffer: Uint8Array; durationMs?: number }):
    Promise<{ ok: boolean; recording?: { id: string; name: string; file: string; url: string; createdAt: string }; error?: string }> =>
    ipcRenderer.invoke('recording-save', opts),
  recordingList:   (): Promise<Array<{
    id: string; name: string; file: string; url: string; createdAt: string;
    durationMs?: number; kind: 'mic' | 'youtube'; sourceUrl?: string;
  }>> => ipcRenderer.invoke('recording-list'),
  recordingDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('recording-delete', id),
  recordingRename: (id: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('recording-rename', id, name),

  // ── Pack archive ─────────────────────────────────────────────────────────
  packExport:      (packId: string):
    Promise<{ ok: boolean; file?: string; soundCount?: number; error?: string }> =>
    ipcRenderer.invoke('pack-export', packId),
  packImport:      ():
    Promise<{ ok: boolean; id?: string; name?: string; soundCount?: number; error?: string }> =>
    ipcRenderer.invoke('pack-import'),

  // ── Virtual driver setup ─────────────────────────────────────────────────
  detectVirtualDriver: (): Promise<{ found: boolean; deviceName?: string }> =>
    ipcRenderer.invoke('audio-detect-virtual-driver'),
  markBlackholeWalkthroughSeen: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('audio-mark-walkthrough-seen'),

  // ── Push events ──────────────────────────────────────────────────────────
  onPackSelected:  (cb: (e: unknown, packId: string) => void): void =>
    void ipcRenderer.on('pack-selected', cb),
  onPacksChanged:  (cb: () => void): void =>
    void ipcRenderer.on('packs-changed', cb),
  onRecordingsChanged: (cb: () => void): void =>
    void ipcRenderer.on('recordings-changed', cb),
  onThemeChanged:  (cb: (e: unknown, theme: string) => void): void =>
    void ipcRenderer.on('theme-changed', cb),
  onGlobalKey:     (cb: (e: unknown, key: string) => void): void =>
    void ipcRenderer.on('global-key', cb),
  onOutputDeviceChanged: (cb: (e: unknown, deviceId: string) => void): void =>
    void ipcRenderer.on('output-device-changed', cb),
  onShowBlackholeWalkthrough: (cb: () => void): void =>
    void ipcRenderer.once('show-blackhole-walkthrough', cb),
});
