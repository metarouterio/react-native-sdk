import { NativeModules } from 'react-native';
import {
  readSnapshot,
  writeSnapshot,
  deleteSnapshot,
} from '../NativeQueueStorage';

function mockNativeStorage() {
  NativeModules.MetaRouterQueueStorage = {
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

  it('writeSnapshot is a no-op if native module is missing', async () => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
    // Should not throw
    await writeSnapshot('data');
  });

  it('deleteSnapshot is a no-op if native module is missing', async () => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
    // Should not throw
    await deleteSnapshot();
  });

  it('readSnapshot returns null on native module error', async () => {
    const mock = mockNativeStorage();
    mock.readSnapshot.mockRejectedValue(new Error('disk error'));
    const result = await readSnapshot();
    expect(result).toBeNull();
  });

  it('writeSnapshot swallows native module error', async () => {
    const mock = mockNativeStorage();
    mock.writeSnapshot.mockRejectedValue(new Error('disk error'));
    // Should not throw
    await writeSnapshot('data');
  });
});
