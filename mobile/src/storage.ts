import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export interface StoredConnection {
  baseUrl: string;
  token: string;
  deviceLabel: string;
}

const STORAGE_KEY = "orchestra.mobile.connection";

async function getItem(key: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    return window.localStorage.getItem(key);
  }
  return AsyncStorage.getItem(key);
}

async function setItem(key: string, value: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem(key, value);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

async function removeItem(key: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    window.localStorage.removeItem(key);
    return;
  }
  await AsyncStorage.removeItem(key);
}

export async function loadStoredConnection(): Promise<StoredConnection | null> {
  const raw = await getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StoredConnection) : null;
}

export async function saveStoredConnection(connection: StoredConnection) {
  await setItem(STORAGE_KEY, JSON.stringify(connection));
}

export async function clearStoredConnection() {
  await removeItem(STORAGE_KEY);
}
