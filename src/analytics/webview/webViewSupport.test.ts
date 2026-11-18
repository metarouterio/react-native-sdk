import { NativeModules, Platform } from 'react-native';
import {
  isBridgeSupported,
  resetBridgeSupportForTests,
} from './webViewSupport';
import { attachWebViewBridge, inertProps } from './webViewBridge';
import { BridgeMessageProcessor } from './bridgeMessageProcessor';

const logger = require('../utils/logger');

describe('isBridgeSupported', () => {
  const originalOS = Platform.OS;
  const originalModule = NativeModules.MetaRouterWebViewSupport;
  let check: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetBridgeSupportForTests();
    check = jest.fn(() => true);
    NativeModules.MetaRouterWebViewSupport = {
      isWebMessageListenerSupported: check,
    };
    (Platform as { OS: string }).OS = 'android';
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
    NativeModules.MetaRouterWebViewSupport = originalModule;
    resetBridgeSupportForTests();
    warnSpy.mockRestore();
  });

  it('is always true on iOS, without asking native', () => {
    (Platform as { OS: string }).OS = 'ios';
    expect(isBridgeSupported()).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses on platforms other than iOS and Android', () => {
    (Platform as { OS: string }).OS = 'windows';
    expect(isBridgeSupported()).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unavailable on windows')
    );
  });

  it('asks the Android WebView provider once per process', () => {
    expect(isBridgeSupported()).toBe(true);
    expect(isBridgeSupported()).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses without WEB_MESSAGE_LISTENER, warning once', () => {
    check.mockReturnValue(false);
    expect(isBridgeSupported()).toBe(false);
    expect(isBridgeSupported()).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('lacks WEB_MESSAGE_LISTENER')
    );
  });

  it('fails closed when the native module is missing', () => {
    NativeModules.MetaRouterWebViewSupport = undefined;
    expect(isBridgeSupported()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('native module is missing')
    );
  });

  it('fails closed when the synchronous call throws', () => {
    check.mockImplementation(() => {
      throw new Error('sync methods unsupported');
    });
    expect(isBridgeSupported()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('feature check failed'),
      expect.any(Error)
    );
  });

  it('still warns about invalid origins when unsupported', () => {
    check.mockReturnValue(false);
    attachWebViewBridge(
      null,
      ['https://unsupported.example.com/'],
      new BridgeMessageProcessor(() => true)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rejects invalid origin rules')
    );
  });

  it('makes attachWebView return inert props when unsupported', () => {
    check.mockReturnValue(false);
    const enqueue = jest.fn(() => true);
    const bridge = attachWebViewBridge(
      null,
      ['https://shop.example.com'],
      new BridgeMessageProcessor(enqueue)
    );
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toBe(
      inertProps().injectedJavaScriptBeforeContentLoaded
    );
    // Bridge-shaped messages are claimed and dropped, never processed.
    expect(
      bridge.onMessage({
        nativeEvent: {
          url: 'https://shop.example.com/',
          data: '__metaRouterBridge:anything:{}',
        },
      })
    ).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
