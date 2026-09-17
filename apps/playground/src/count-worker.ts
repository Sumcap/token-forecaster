/// <reference lib="webworker" />
import {
  estimateRequestTokens,
  type EstimatableRequest,
} from "@token-forecaster/token-counter";

/**
 * Local counting runs off the main thread. Each request carries a monotonic
 * id; the main thread discards responses that are not the latest, so slow
 * worker runs can never overwrite a newer estimate.
 */

export interface CountWorkerRequest {
  id: number;
  request: EstimatableRequest;
}

export interface CountWorkerResponse {
  id: number;
  tokens: number;
}

self.onmessage = (event: MessageEvent<CountWorkerRequest>) => {
  const { id, request } = event.data;
  const tokens = estimateRequestTokens(request);
  const response: CountWorkerResponse = { id, tokens };
  self.postMessage(response);
};
