import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'auth-token';

export const getStoredToken = () => SecureStore.getItemAsync(TOKEN_KEY);

export const storeToken = (value: string | null) =>
  value === null
    ? SecureStore.deleteItemAsync(TOKEN_KEY)
    : SecureStore.setItemAsync(TOKEN_KEY, value);
