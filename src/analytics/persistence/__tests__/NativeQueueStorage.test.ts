import { NativeModules } from 'react-native';
import {
  exists,
  readSnapshot,
  writeSnapshot,
  deleteSnapshot,
} from '../NativeQueueStorage';

function mockNativeStorage() {
  NativeModules.MetaRouterQueueStorage = {
    exists: jest.fn().mockResolvedValue(false),
    readSnapshot: jest.fn().mockResolvedValue(null),
    writeSnapshot: jest.fn().mockResolvedValue(undefined),
    deleteSnapshot: jest.fn().mockResolvedValue(undefined),
  };
  return NativeModules.MetaRouterQueueStorage;
}

describe('NativeQueueStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore to empty so other test suites aren't affected
    NativeModules.MetaRouterQueueStorage = undefined as any;
  });

  it('exists delegates to native module', async () => {
    const mock = mockNativeStorage();
    mock.exists.mockResolvedValue(true);
    const result = await exists();
    expect(result).toBe(true);
    expect(mock.exists).toHaveBeenCalled();
  });

  it('readSnapshot returns null when native module returns null', async () => {
    const mock = mockNativeStorage();
    mock.readSnapshot.mockResolvedValue(null);
    const result = await readSnapshot();
    expect(result).toBeNull();
    expect(mock.readSnapshot).toHaveBeenCalled();
  });

  it('readSnapshot returns string data from native module', async () => {
    const mock = mockNativeStorage();
    const data = JSON.stringify({ version: 1, events: [] });
    mock.readSnapshot.mockResolvedValue(data);
    const result = await readSnapshot();
    expect(result).toBe(data);
  });

  it('writeSnapshot passes data string to native module', async () => {
    const mock = mockNativeStorage();
    await writeSnapshot('{"version":1,"events":[]}');
    expect(mock.writeSnapshot).toHaveBeenCalledWith(
      '{"version":1,"events":[]}'
    );
  });

  it('deleteSnapshot calls native module', async () => {
    const mock = mockNativeStorage();
    await deleteSnapshot();
    expect(mock.deleteSnapshot).toHaveBeenCalled();
  });

  it('readSnapshot returns null if native module is missing', async () => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
    const result = await readSnapshot();
    expect(result).toBeNull();
  });

  it('writeSnapshot rejects if native module is missing', async () => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
    await expect(writeSnapshot('data')).rejects.toThrow(
      /native module is not available/
    );
  });

  it('deleteSnapshot is a no-op if native module is missing', async () => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
    // Should not throw
    await deleteSnapshot();
  });

  it('readSnapshot rejects on native module error', async () => {
    const mock = mockNativeStorage();
    mock.readSnapshot.mockRejectedValue(new Error('disk error'));
    await expect(readSnapshot()).rejects.toThrow('disk error');
  });

  it('writeSnapshot rejects on native module error', async () => {
    const mock = mockNativeStorage();
    mock.writeSnapshot.mockRejectedValue(new Error('disk error'));
    await expect(writeSnapshot('data')).rejects.toThrow('disk error');
  });

  it('deleteSnapshot rejects on native module error', async () => {
    const mock = mockNativeStorage();
    mock.deleteSnapshot.mockRejectedValue(new Error('disk error'));
    await expect(deleteSnapshot()).rejects.toThrow('disk error');
  });
});
