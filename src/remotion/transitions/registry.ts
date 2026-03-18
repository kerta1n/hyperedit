import type React from 'react';

const registry = new Map<string, React.FC<any>>();

export function registerTransition(id: string, component: React.FC<any>): void {
  registry.set(id, component);
}

export function getTransition(id: string): React.FC<any> | undefined {
  return registry.get(id);
}

export function getRegisteredTransitionIds(): string[] {
  return Array.from(registry.keys());
}

// Side-effect import: triggers registration of all installed custom transitions
import './custom';
