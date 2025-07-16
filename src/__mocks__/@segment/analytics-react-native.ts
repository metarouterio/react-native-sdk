import { jest } from '@jest/globals';

export class Plugin {
  type = 'plugin';
  execute = jest.fn();
  configure = jest.fn();
}

export class DestinationPlugin extends Plugin {
  type = 'destination';
}

export enum PluginType {
  before = 'before',
  enrichment = 'enrichment',
  destination = 'destination',
  after = 'after',
}

export const createClient = jest.fn((config?: any) => mockClient);

export const mockClient = {
  init: jest.fn(),
  track: jest.fn(),
  identify: jest.fn(),
  screen: jest.fn(),
  group: jest.fn(),
  alias: jest.fn(),
  flush: jest.fn(),
  cleanup: jest.fn(),
  add: jest.fn(),
};