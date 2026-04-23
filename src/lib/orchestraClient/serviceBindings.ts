import type {
  OrchestraCatalogService,
  OrchestraInboxService,
  OrchestraSessionService,
  OrchestraTaskService,
  OrchestraAppService,
} from "./client";

export interface OrchestraClientServiceBindings {
  app: OrchestraAppService;
  catalog: OrchestraCatalogService;
  tasks: OrchestraTaskService;
  inbox: OrchestraInboxService;
  sessions: OrchestraSessionService;
}
