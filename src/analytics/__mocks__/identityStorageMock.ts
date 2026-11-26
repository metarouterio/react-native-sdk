/**
 * Test helper: completes a jest.mock factory for utils/identityStorage with
 * the exports the SDK uses beyond the factory's plain get/set/remove. The
 * `readIdentityField` here wraps the mocked getIdentityField once (no retry)
 * and returns the production shape: a rejected read is `ok: false`.
 */
export function completeIdentityStorageMock<
  T extends { getIdentityField: jest.Mock },
>(mocked: T) {
  const read = async (key: string) => {
    try {
      const raw = (await mocked.getIdentityField(key)) as string | null;
      return { ok: true as const, raw: raw ?? null };
    } catch (error) {
      return { ok: false as const, error };
    }
  };
  return {
    HOST_SET_MARKER_KEY: 'metarouter:anonymous_id_host_set',
    currentIdentityEpoch: jest.fn(() => 0),
    writeHostAnonymousId: jest.fn(() => Promise.resolve()),
    clearIdentityStorage: jest.fn(() => Promise.resolve()),
    ...mocked,
    readIdentityField: jest.fn(read),
    readIdentityFields: jest.fn((keys: readonly string[]) =>
      Promise.all(keys.map(read))
    ),
  };
}
