; Uninstalling removes the app, but its data lives in %APPDATA%\<identifier> and
; would otherwise be left behind: the search index, chat history, saved rules,
; the stored API key, and any files still sitting in the app's own Trash.
; Deleting that is destructive (those trashed files are the user's), so it is
; opt-in and defaults to No.
!macro NSIS_HOOK_POSTUNINSTALL
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "Also delete FileOrganizer's data?$\r$\n$\r$\nThis removes the search index, chat history, saved rules and your stored API key.$\r$\n$\r$\nAny files still in the app's Trash will be deleted permanently. Restore them first if you want to keep them.$\r$\n$\r$\nChoose No to keep everything." \
    IDNO keep_data
  RMDir /r "$APPDATA\${BUNDLEID}"
  keep_data:
!macroend
