const TOKEN_KEY = 'auth-token';

export async function getStoredToken(): Promise<string | null> {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY);
}

export async function storeToken(value: string | null): Promise<void> {
  if (typeof window === 'undefined') return;
  if (value === null) window.localStorage.removeItem(TOKEN_KEY);
  else window.localStorage.setItem(TOKEN_KEY, value);
}
