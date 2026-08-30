"use client";

import { useEffect, useRef, useState } from "react";

export type UiNotificationMode = "success" | "warning" | "error";

export type UiNotificationItem = {
  id: string;
  mode: UiNotificationMode;
  message: string;
  title?: string;
};

const AUTO_DISMISS_MS: Record<UiNotificationMode, number> = {
  success: 3600,
  warning: 5200,
  error: 0,
};

function NotificationCard({
  item,
  onDismiss,
}: {
  item: UiNotificationItem;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timeoutMs = AUTO_DISMISS_MS[item.mode];
    if (!timeoutMs) {
      return;
    }

    const timeout = window.setTimeout(() => {
      onDismiss(item.id);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [item.id, item.mode, onDismiss]);

  return (
    <article className="ui_notification" data-mode={item.mode} role="status" aria-live="polite">
      <div className="ui_notification_copy">
        {item.title ? <p className="ui_notification_title">{item.title}</p> : null}
        <p className="ui_notification_message">{item.message}</p>
      </div>
      <button
        type="button"
        className="ui_icon_button ui_notification_close"
        aria-label="Close notification"
        onClick={() => onDismiss(item.id)}
      >
        ×
      </button>
    </article>
  );
}

export function NotificationCenter({
  items,
}: {
  items: UiNotificationItem[];
}) {
  const [notifications, setNotifications] = useState<UiNotificationItem[]>([]);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    setNotifications((current) => {
      const next = [...current];

      for (const item of items) {
        if (seenIds.current.has(item.id)) {
          continue;
        }

        seenIds.current.add(item.id);
        next.push(item);
      }

      return next;
    });
  }, [items]);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="ui_notifications" aria-live="polite" aria-atomic="false">
      {notifications.map((item) => (
        <NotificationCard
          key={item.id}
          item={item}
          onDismiss={(id) =>
            setNotifications((current) => current.filter((entry) => entry.id !== id))
          }
        />
      ))}
    </div>
  );
}
