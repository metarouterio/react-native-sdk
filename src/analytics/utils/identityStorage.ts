import AsyncStorage from '@react-native-async-storage/async-storage';

export const ANONYMOUS_ID_KEY = 'metarouter:anonymous_id';
export const USER_ID_KEY = 'metarouter:user_id';
export const GROUP_ID_KEY = 'metarouter:group_id';

export async function getIdentityField(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setIdentityField(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // Optionally log error
  }
}

export async function removeIdentityField(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Optionally log error
  }
}