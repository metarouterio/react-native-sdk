import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';

const STORAGE_KEY = 'metarouter:anonymous_id';

export async function getAnonymousId(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const anonId = uuidv4();
  await AsyncStorage.setItem(STORAGE_KEY, anonId);
  return anonId;
}