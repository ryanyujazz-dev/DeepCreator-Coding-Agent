export const browserPlatform = {
  createId: (prefix: string) => `${prefix}_${crypto.randomUUID()}`,
  isOnline: () => navigator.onLine,
  reload: () => window.location.reload(),
  storage: {
    get: (key: string) => window.localStorage.getItem(key),
    set: (key: string, value: string) => window.localStorage.setItem(key, value)
  },
  viewportWidth: () => window.innerWidth
};
