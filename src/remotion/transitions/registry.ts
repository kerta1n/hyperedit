import type React from 'react';
import type { TransitionParamSchema, TransitionMeta } from './types';

export interface RegisteredTransition {
  component: React.FC<any>;
  params: TransitionParamSchema;
  meta: TransitionMeta;
}

const registry = new Map<string, RegisteredTransition>();

export function registerTransition(
  id: string,
  component: React.FC<any>,
  params: TransitionParamSchema = {},
  meta: TransitionMeta = { name: id },
): void {
  registry.set(id, { component, params, meta });
}

export function getTransition(id: string): React.FC<any> | undefined {
  return registry.get(id)?.component;
}

export function getTransitionEntry(id: string): RegisteredTransition | undefined {
  return registry.get(id);
}

export function getTransitionMeta(id: string): TransitionMeta | undefined {
  return registry.get(id)?.meta;
}

export function getTransitionParams(id: string): TransitionParamSchema | undefined {
  return registry.get(id)?.params;
}

export function getRegisteredTransitionIds(): string[] {
  return Array.from(registry.keys());
}

export function getRegisteredTransitions(): Array<{ id: string } & RegisteredTransition> {
  return Array.from(registry.entries()).map(([id, entry]) => ({ id, ...entry }));
}

