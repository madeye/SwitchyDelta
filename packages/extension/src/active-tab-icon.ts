/**
 * Active-tab icon tracking.
 *
 * When the current profile is inclusive (auto switch / rule list), the icon
 * colour should follow the profile that the *active tab's URL* resolves to.
 * The original painted a per-tab icon for every tab from tabs.coffee; this
 * build tracks only the active tab and paints the single global icon, so the
 * worker wakes far less often and no per-tab state has to survive suspension.
 */

const TRACKING_FLAG = 'activeTabIconTracking';

/**
 * Remember whether the current profile's colour depends on the tab URL.
 *
 * Stored in session storage so a tab-switch event can check it without
 * booting the options controller: with a static profile the worker returns
 * to idle immediately instead of loading and matching for nothing.
 */
export function setActiveTabIconTracking(enabled: boolean): void {
  void chrome.storage.session?.set({ [TRACKING_FLAG]: enabled });
}

/**
 * Repaint on every event that changes which tab is active or what URL it
 * shows. Must be called from the worker's first turn so the events can wake
 * a suspended worker.
 */
export function watchActiveTab(repaint: () => void): void {
  const maybeRepaint = (): void => {
    void (async () => {
      const flags = await chrome.storage.session?.get(TRACKING_FLAG);
      // An absent flag (first event of the browser session) falls through to
      // repaint, which re-derives and re-stores it.
      if (flags?.[TRACKING_FLAG] === false) return;
      repaint();
    })();
  };
  chrome.tabs.onActivated.addListener(() => maybeRepaint());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!tab.active || changeInfo.url === undefined) return;
    maybeRepaint();
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    maybeRepaint();
  });
}
