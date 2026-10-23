/** The English dictionary defines the key set; `ko` must provide exactly the same keys. */
export const en = {
  "app.name": "codesh",
  "app.tagline": "Share code in real time on your intranet",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.confirm": "Confirm",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.delete": "Delete",
  "common.loading": "Loading…",
  "common.retry": "Try again",
  "common.save": "Save",
  "error.generic": "Something went wrong. Please try again.",
  "nav.home": "Home",
  "nav.myShares": "My shares",
  "share.new": "New share",
  "share.joinWithCode": "Join with a code",
  "share.codePlaceholder": "6-digit code",
  "share.linkCopied": "Link copied",
  "status.connected": "Connected",
  "status.reconnecting": "Reconnecting…",
  "status.offline": "Offline – changes are kept",
  "locale.ko": "한국어",
  "locale.en": "English",
  "greeting.hello": "Hello, {name}",
} as const;

export type MessageKey = keyof typeof en;
