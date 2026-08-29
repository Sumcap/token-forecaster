/**
 * The slice of the Chrome extension API this extension actually uses.
 *
 * A hand-written declaration instead of `@types/chrome` on purpose: the
 * surface is tiny, it keeps the dependency tree of a browser-shipped bundle
 * honest, and an API this file does not declare cannot be called by accident.
 */
declare namespace chrome {
  namespace runtime {
    const id: string | undefined;
    const lastError: { message?: string } | undefined;
    function sendMessage<Request, Response>(message: Request): Promise<Response>;
    function openOptionsPage(): Promise<void>;
    function getURL(path: string): string;
    function getManifest(): { version: string };
    const onInstalled: {
      addListener(
        listener: (details: { reason: string; previousVersion?: string }) => void,
      ): void;
    };
    const onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined | void,
      ): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const onChanged: {
      addListener(
        listener: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          areaName: string,
        ) => void,
      ): void;
    };
  }

  namespace tabs {
    function create(properties: { url: string; active?: boolean }): Promise<unknown>;
  }

  namespace action {
    const onClicked: {
      addListener(listener: (tab: unknown) => void): void;
    };
  }

  namespace permissions {
    function contains(permissions: { origins: string[] }): Promise<boolean>;
    function request(permissions: { origins: string[] }): Promise<boolean>;
    function remove(permissions: { origins: string[] }): Promise<boolean>;
  }

  namespace alarms {
    interface Alarm {
      name: string;
    }
    function create(name: string, alarmInfo: { periodInMinutes: number }): void;
    const onAlarm: {
      addListener(listener: (alarm: Alarm) => void): void;
    };
  }
}
