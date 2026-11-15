import { chooseAction } from './search';
import type { Difficulty, Observation } from '../game/types';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; observation: Observation; difficulty: Difficulty }>) => void) | null;
  postMessage: (message: unknown) => void;
};
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ id: data.id, ok: true, ...chooseAction(data.observation, data.difficulty) }); }
  catch (error) { scope.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : '电脑计算失败' }); }
};
