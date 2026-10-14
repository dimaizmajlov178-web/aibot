export interface BotModule {
  name: string;
}

export function describeModules(modules: readonly BotModule[]): string {
  return modules.map((module) => module.name).join(", ");
}
