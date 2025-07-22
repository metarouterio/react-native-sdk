import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import { log, warn } from './logger';

const STORAGE_KEY = 'metarouter:anonymous_id';

export async function getAnonymousId(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    if (existing) {
      log('Retrieved existing anonymous ID from storage');
      return existing;
    }
  } catch (error) {
    warn('Failed to read anonymous ID from storage, generating new one', error);
  }

  const anonId = uuidv4();
  log('Generated new anonymous ID:', anonId);
  
  try {
    await AsyncStorage.setItem(STORAGE_KEY, anonId);
    log('Stored anonymous ID in storage');
  } catch (error) {
    warn('Failed to store anonymous ID in storage, but continuing with generated ID', error);
  }
  
  return anonId;
}