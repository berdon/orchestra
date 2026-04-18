import AsyncStorage from "@react-native-async-storage/async-storage";

export interface StoredConnection {
  baseUrl: string;
  token: string;
  deviceLabel: string;
}

const STORAGE_KEY = "orchestra.mobile.connection";

export async function loadStoredConnection(): Promise<StoredConnection | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StoredConnection) : null;
}

export async function saveStoredConnection(connection: StoredConnection) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export async function clearStoredConnection() {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
