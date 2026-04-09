export type NetworkStatus = 'connected' | 'disconnected';

export interface NetworkReachability {
  onStatusChange(callback: (status: NetworkStatus) => void): () => void;
  stop(): void;
}
