; Included by electron-builder's NSIS script (nsis.include, spec §12).
; The app registers ghostlink:// under HKCU at run time (app.setAsDefaultProtocolClient),
; so the uninstaller removes that key. An update runs the old uninstaller with --updated:
; keep the key then, or deep links break until the new version starts once.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\ghostlink"
  ${endIf}
!macroend
