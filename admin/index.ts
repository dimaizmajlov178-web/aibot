import type { BotModule } from "../core/modules";

export const adminModule: BotModule = { name: "admin" };

export { registerAdminHandlers } from "./commands";
export type { AdminHandlersDeps } from "./commands";
export {
  formatAdminMenu,
  formatGlobalPause,
  formatGranted,
  formatRevoked,
  formatUserList,
} from "./commands";
