/** System notifications (Notification API). Permission is only ever requested from a click. */

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Shows a notification only when the tab is hidden and the person allowed it. */
export function notifyHidden(
  title: string,
  options: { body?: string; tag?: string; onClick?: () => void },
) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;
  try {
    const notification = new Notification(title, { body: options.body, tag: options.tag });
    notification.onclick = () => {
      window.focus();
      options.onClick?.();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications through a service worker; the toast still shows.
  }
}
