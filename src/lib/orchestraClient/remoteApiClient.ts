import type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentOperationsDetail,
  AgentOperationsSnapshot,
  AgentQueueEntry,
  AgentQueueEntryInput,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationResult,
  AppInfo,
  ArchiveMailboxMessagesInput,
  ChannelActivityEntry,
  ChannelDetail,
  ChannelSummary,
  ChannelUpsertInput,
  MailboxMessage,
  MarkMailboxMessagesReadInput,
  PiExecutableDiagnostic,
  PolicyDefinition,
  PolicySummary,
  ProjectDetail,
  ProjectSessionPromptSettings,
  ProjectSourceControlSettings,
  ProjectSummary,
  ProjectTaskAutomationSettings,
  ProjectUpsertInput,
  ProjectWorkerOverlay,
  QueuedSessionMessage,
  RepositoryRecord,
  RepositoryRemoteInput,
  RepositoryUpsertInput,
  ResolvedPermissions,
  RoleDefinition,
  RoleOperationsDetail,
  RoleOperationsSnapshot,
  RoleQueueEntry,
  RoleQueueEntryInput,
  RoleSummary,
  RoleUpsertInput,
  RoleValidationResult,
  SendMailboxMessageInput,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionRuntimeDetails,
  SessionStats,
  SourceControlSettings,
  TaskAttachment,
  TaskAttachmentInput,
  TaskComment,
  TaskCommentFileMentionCandidate,
  TaskCommentInput,
  TaskCommentUpdateInput,
  TaskDependency,
  TaskDetail,
  TaskFileReference,
  TaskFileReferenceInput,
  TaskListOptions,
  TaskScheduleDetail,
  TaskScheduleSummary,
  TaskScheduleUpsertInput,
  TaskSummary,
  TaskTodo,
  TaskTodoInput,
  TaskUpsertInput,
  TelegramBotValidation,
  TelegramChatCandidate,
  WorkflowDefinition,
  WorkflowDeleteImpact,
  WorkflowSummary,
  WorkflowUpsertInput,
  WorkflowValidationResult,
} from "../../types";
import { ORCHESTRA_CLIENT_CONTRACT_VERSION, type OrchestraClientBootstrap } from "./bootstrap";
import {
  createOptimisticConnectionSnapshot,
  OrchestraConnectionController,
} from "./connection";
import type {
  OrchestraClient,
  OrchestraClientBinding,
  OrchestraRoleInstanceReleaseOutcome,
  OrchestraTaskCompletionOutcome,
} from "./client";
import { createLocalNotificationsExtension } from "./localNotificationsExtension";
import { RemoteApiEventManager } from "./remoteApiEvents";
import {
  createRemoteApiTaskListQuery,
  createRemoteApiTransport,
  describeRemoteApiError,
  fetchRemoteApiAppInfo,
  type RemoteApiOrchestraClientOptions,
} from "./remoteApiTransport";

interface NotesInput {
  notes?: string;
}

function createNotesBody(notes?: string): NotesInput | undefined {
  return notes ? { notes } : undefined;
}

export function createRemoteApiOrchestraClientBinding(
  bootstrap: OrchestraClientBootstrap,
  options?: RemoteApiOrchestraClientOptions,
): OrchestraClientBinding {
  const connectionController = new OrchestraConnectionController(createOptimisticConnectionSnapshot(bootstrap));
  const transport = createRemoteApiTransport(bootstrap, options, connectionController);
  const eventManager = new RemoteApiEventManager(transport, bootstrap, connectionController, options);

  async function getAppInfo(): Promise<AppInfo> {
    if (bootstrap.appInfo) {
      return bootstrap.appInfo;
    }
    return fetchRemoteApiAppInfo(transport, bootstrap);
  }

  const client: OrchestraClient = {
    contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
    async getBootstrap() {
      return bootstrap;
    },
    app: {
      getInfo: getAppInfo,
      async reportError(target, error, fallback) {
        const message = describeRemoteApiError(error, fallback);
        console.error(`[${target}] ${message}`, error);
        if (bootstrap.capabilities.app.errorReporting.availability !== "available") {
          return message;
        }
        try {
          await transport.requestVoid("app.reportError", {
            method: "POST",
            path: "/api/v1/client-errors",
            body: {
              target,
              message,
            },
          });
        } catch (reportingError) {
          console.error("[orchestra-client.remote-api.reportError]", reportingError);
        }
        return message;
      },
    },
    catalog: {
      listProjects: () => {
        transport.assertCapability("catalog.listProjects", bootstrap.capabilities.catalog.projects);
        return transport.requestJson<ProjectSummary[]>("catalog.listProjects", {
          path: "/api/v1/projects",
        });
      },
      getProject: (projectId) => {
        transport.assertCapability("catalog.getProject", bootstrap.capabilities.catalog.projects);
        return transport.requestJson<ProjectDetail>("catalog.getProject", {
          path: `/api/v1/projects/${encodeURIComponent(projectId)}`,
        });
      },
      listAgents: (includeArchived = false, projectId) => {
        transport.assertCapability("catalog.listAgents", bootstrap.capabilities.catalog.agents);
        return transport.requestJson<AgentSummary[]>("catalog.listAgents", {
          path: "/api/v1/agents",
          query: {
            includeArchived,
            projectId: projectId ?? undefined,
          },
        });
      },
      listRoles: (includeArchived = false) => {
        transport.assertCapability("catalog.listRoles", bootstrap.capabilities.catalog.roles);
        return transport.requestJson<RoleSummary[]>("catalog.listRoles", {
          path: "/api/v1/roles",
          query: {
            includeArchived,
          },
        });
      },
      listWorkflows: (includeArchived = false) => {
        transport.assertCapability("catalog.listWorkflows", bootstrap.capabilities.catalog.workflows);
        return transport.requestJson<WorkflowSummary[]>("catalog.listWorkflows", {
          path: "/api/v1/workflows",
          query: {
            includeArchived,
          },
        });
      },
      getWorkflow: (workflowId) => {
        transport.assertCapability("catalog.getWorkflow", bootstrap.capabilities.catalog.workflows);
        return transport.requestJson<WorkflowDefinition>("catalog.getWorkflow", {
          path: `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
        });
      },
    },
    projects: {
      createProject: (input: ProjectUpsertInput) => {
        transport.assertCapability("projects.createProject", bootstrap.capabilities.admin.projects);
        return transport.requestJson<ProjectDetail>("projects.createProject", {
          method: "POST",
          path: "/api/v1/projects",
          body: input,
        });
      },
      updateProject: (projectId, input: ProjectUpsertInput) => {
        transport.assertCapability("projects.updateProject", bootstrap.capabilities.admin.projects);
        return transport.requestJson<ProjectDetail>("projects.updateProject", {
          method: "PATCH",
          path: `/api/v1/projects/${encodeURIComponent(projectId)}`,
          body: input,
        });
      },
      deleteProject: (projectId) => {
        transport.assertCapability("projects.deleteProject", bootstrap.capabilities.admin.projects);
        return transport.requestJson<ProjectDetail>("projects.deleteProject", {
          method: "DELETE",
          path: `/api/v1/projects/${encodeURIComponent(projectId)}`,
        });
      },
      listRepositories: (projectId) => {
        transport.assertCapability("projects.listRepositories", bootstrap.capabilities.admin.projects);
        return transport.requestJson<RepositoryRecord[]>("projects.listRepositories", {
          path: projectId ? `/api/v1/projects/${encodeURIComponent(projectId)}/repositories` : "/api/v1/repositories",
          query: projectId ? undefined : { projectId: projectId ?? undefined },
        });
      },
      getRepository: (repositoryId) => {
        transport.assertCapability("projects.getRepository", bootstrap.capabilities.admin.projects);
        return transport.requestJson<RepositoryRecord>("projects.getRepository", {
          path: `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
        });
      },
      createRepository: (projectId, input: RepositoryUpsertInput) => {
        transport.assertCapability("projects.createRepository", bootstrap.capabilities.admin.projects);
        return transport.requestJson<RepositoryRecord>("projects.createRepository", {
          method: "POST",
          path: `/api/v1/projects/${encodeURIComponent(projectId)}/repositories`,
          body: input,
        });
      },
      updateRepository: (repositoryId, input: RepositoryUpsertInput) => {
        transport.assertCapability("projects.updateRepository", bootstrap.capabilities.admin.projects);
        return transport.requestJson<RepositoryRecord>("projects.updateRepository", {
          method: "PATCH",
          path: `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
          body: input,
        });
      },
      deleteRepository: (repositoryId) => {
        transport.assertCapability("projects.deleteRepository", bootstrap.capabilities.admin.projects);
        return transport.requestJson<RepositoryRecord>("projects.deleteRepository", {
          method: "DELETE",
          path: `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
        });
      },
      attachRepositoryRemote: (repositoryId, input: RepositoryRemoteInput) => {
        transport.assertCapability("projects.attachRepositoryRemote", bootstrap.capabilities.admin.projects);
        return transport.requestJson<RepositoryRecord>("projects.attachRepositoryRemote", {
          method: "POST",
          path: `/api/v1/repositories/${encodeURIComponent(repositoryId)}/attach-remote`,
          body: input,
        });
      },
      setProjectDefaultRepository: (projectId, repositoryId) => {
        transport.assertCapability("projects.setProjectDefaultRepository", bootstrap.capabilities.admin.projects);
        return transport.requestJson<ProjectDetail>("projects.setProjectDefaultRepository", {
          method: "POST",
          path: `/api/v1/projects/${encodeURIComponent(projectId)}/default-repository`,
          body: {
            repositoryId,
          },
        });
      },
    },
    settings: {
      listPiModels: () => {
        transport.assertCapability("settings.listPiModels", bootstrap.capabilities.admin.modelCatalog);
        return transport.requestJson<SessionModel[]>("settings.listPiModels", {
          path: "/api/v1/models",
        });
      },
      getPiExecutableDiagnostic: () => {
        transport.assertCapability("settings.getPiExecutableDiagnostic", bootstrap.capabilities.admin.piExecutableDiagnostic, {
          reason: "Local Pi executable diagnostics are only available in the desktop host.",
        });
        throw new Error("unreachable");
      },
      getSourceControlSettings: () => {
        transport.assertCapability("settings.getSourceControlSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<SourceControlSettings>("settings.getSourceControlSettings", {
          path: "/api/v1/settings/source-control",
        });
      },
      updateSourceControlSettings: (gitUserNameTemplate, gitEmailTemplate) => {
        transport.assertCapability("settings.updateSourceControlSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<SourceControlSettings>("settings.updateSourceControlSettings", {
          method: "PATCH",
          path: "/api/v1/settings/source-control",
          body: {
            gitUserNameTemplate,
            gitEmailTemplate,
          },
        });
      },
      getProjectSourceControlSettings: (projectSlug) => {
        transport.assertCapability("settings.getProjectSourceControlSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectSourceControlSettings>("settings.getProjectSourceControlSettings", {
          path: "/api/v1/project-settings/source-control",
          query: {
            projectSlug: projectSlug ?? undefined,
          },
        });
      },
      updateProjectSourceControlSettings: (gitUserNameTemplate, gitEmailTemplate, projectSlug) => {
        transport.assertCapability("settings.updateProjectSourceControlSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectSourceControlSettings>("settings.updateProjectSourceControlSettings", {
          method: "PATCH",
          path: "/api/v1/project-settings/source-control",
          body: {
            projectSlug: projectSlug ?? null,
            gitUserNameTemplate,
            gitEmailTemplate,
          },
        });
      },
      getSessionPromptSettings: (projectSlug) => {
        transport.assertCapability("settings.getSessionPromptSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectSessionPromptSettings>("settings.getSessionPromptSettings", {
          path: "/api/v1/project-settings/session-prompt",
          query: {
            projectSlug: projectSlug ?? undefined,
          },
        });
      },
      updateSessionPromptSettings: (template, projectSlug) => {
        transport.assertCapability("settings.updateSessionPromptSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectSessionPromptSettings>("settings.updateSessionPromptSettings", {
          method: "PATCH",
          path: "/api/v1/project-settings/session-prompt",
          body: {
            projectSlug: projectSlug ?? null,
            template,
          },
        });
      },
      getTaskAutomationSettings: (projectSlug) => {
        transport.assertCapability("settings.getTaskAutomationSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectTaskAutomationSettings>("settings.getTaskAutomationSettings", {
          path: "/api/v1/project-settings/task-automation",
          query: {
            projectSlug: projectSlug ?? undefined,
          },
        });
      },
      updateTaskAutomationSettings: (autoDispatchOnBlockerCompletion, projectSlug) => {
        transport.assertCapability("settings.updateTaskAutomationSettings", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectTaskAutomationSettings>("settings.updateTaskAutomationSettings", {
          method: "PATCH",
          path: "/api/v1/project-settings/task-automation",
          body: {
            projectSlug: projectSlug ?? null,
            autoDispatchOnBlockerCompletion,
          },
        });
      },
      getWorkerOverlay: (workerType, workerSlug, projectSlug) => {
        transport.assertCapability("settings.getWorkerOverlay", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectWorkerOverlay>("settings.getWorkerOverlay", {
          path: "/api/v1/project-settings/worker-overlay",
          query: {
            projectSlug: projectSlug ?? undefined,
            workerType,
            workerSlug,
          },
        });
      },
      updateWorkerOverlay: (workerType, workerSlug, prompt, projectSlug) => {
        transport.assertCapability("settings.updateWorkerOverlay", bootstrap.capabilities.admin.settings);
        return transport.requestJson<ProjectWorkerOverlay>("settings.updateWorkerOverlay", {
          method: "PATCH",
          path: "/api/v1/project-settings/worker-overlay",
          body: {
            projectSlug: projectSlug ?? null,
            workerType,
            workerSlug,
            prompt,
          },
        });
      },
    },
    workers: {
      validateAgent: (input: AgentUpsertInput) => {
        transport.assertCapability("workers.validateAgent", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentValidationResult>("workers.validateAgent", {
          method: "POST",
          path: "/api/v1/agents/validate",
          body: input,
        });
      },
      getAgent: (agentId, projectId) => {
        transport.assertCapability("workers.getAgent", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentDefinition>("workers.getAgent", {
          path: `/api/v1/agents/${encodeURIComponent(agentId)}`,
          query: {
            projectId: projectId ?? undefined,
          },
        });
      },
      createAgent: (input: AgentUpsertInput) => {
        transport.assertCapability("workers.createAgent", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentDefinition>("workers.createAgent", {
          method: "POST",
          path: "/api/v1/agents",
          body: input,
        });
      },
      updateAgent: (agentId, input: AgentUpsertInput) => {
        transport.assertCapability("workers.updateAgent", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentDefinition>("workers.updateAgent", {
          method: "PATCH",
          path: `/api/v1/agents/${encodeURIComponent(agentId)}`,
          body: input,
        });
      },
      archiveAgent: (agentId) => {
        transport.assertCapability("workers.archiveAgent", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentDefinition>("workers.archiveAgent", {
          method: "POST",
          path: `/api/v1/agents/${encodeURIComponent(agentId)}/archive`,
        });
      },
      getAgentMemoryInfo: (agentId) => {
        transport.assertCapability("workers.getAgentMemoryInfo", { availability: "unavailable", reason: "Agent memory bootstrap paths are only available in the desktop host." }, { agentId });
        throw new Error("unreachable");
      },
      listAgentOperations: (includeArchived = false, projectId) => {
        transport.assertCapability("workers.listAgentOperations", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentOperationsSnapshot[]>("workers.listAgentOperations", {
          path: "/api/v1/agent-operations",
          query: {
            includeArchived,
            projectId: projectId ?? undefined,
          },
        });
      },
      getAgentOperations: (agentId, projectId) => {
        transport.assertCapability("workers.getAgentOperations", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentOperationsDetail>("workers.getAgentOperations", {
          path: `/api/v1/agents/${encodeURIComponent(agentId)}/operations`,
          query: {
            projectId: projectId ?? undefined,
          },
        });
      },
      ensureAgentSession: (agentId, projectId) => {
        transport.assertCapability("workers.ensureAgentSession", bootstrap.capabilities.admin.workers);
        return transport.requestJson<SessionRecord>("workers.ensureAgentSession", {
          method: "POST",
          path: `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/ensure`,
          query: {
            projectId: projectId ?? undefined,
          },
        });
      },
      enqueueAgentWork: (input: AgentQueueEntryInput) => {
        transport.assertCapability("workers.enqueueAgentWork", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentQueueEntry>("workers.enqueueAgentWork", {
          method: "POST",
          path: "/api/v1/agent-queue",
          body: input,
        });
      },
      deleteAgentQueueEntry: (queueEntryId) => {
        transport.assertCapability("workers.deleteAgentQueueEntry", bootstrap.capabilities.admin.workers);
        return transport.requestJson<AgentQueueEntry>("workers.deleteAgentQueueEntry", {
          method: "DELETE",
          path: `/api/v1/agent-queue/${encodeURIComponent(queueEntryId)}`,
        });
      },
      getAgentPermissions: (agentId) => {
        transport.assertCapability("workers.getAgentPermissions", bootstrap.capabilities.admin.workers);
        return transport.requestJson<ResolvedPermissions>("workers.getAgentPermissions", {
          path: `/api/v1/agents/${encodeURIComponent(agentId)}/permissions`,
        });
      },
      validateRole: (input: RoleUpsertInput) => {
        transport.assertCapability("workers.validateRole", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleValidationResult>("workers.validateRole", {
          method: "POST",
          path: "/api/v1/roles/validate",
          body: input,
        });
      },
      getRole: (roleId) => {
        transport.assertCapability("workers.getRole", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleDefinition>("workers.getRole", {
          path: `/api/v1/roles/${encodeURIComponent(roleId)}`,
        });
      },
      createRole: (input: RoleUpsertInput) => {
        transport.assertCapability("workers.createRole", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleDefinition>("workers.createRole", {
          method: "POST",
          path: "/api/v1/roles",
          body: input,
        });
      },
      updateRole: (roleId, input: RoleUpsertInput) => {
        transport.assertCapability("workers.updateRole", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleDefinition>("workers.updateRole", {
          method: "PATCH",
          path: `/api/v1/roles/${encodeURIComponent(roleId)}`,
          body: input,
        });
      },
      archiveRole: (roleId) => {
        transport.assertCapability("workers.archiveRole", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleDefinition>("workers.archiveRole", {
          method: "POST",
          path: `/api/v1/roles/${encodeURIComponent(roleId)}/archive`,
        });
      },
      listRoleOperations: (includeArchived = false) => {
        transport.assertCapability("workers.listRoleOperations", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleOperationsSnapshot[]>("workers.listRoleOperations", {
          path: "/api/v1/role-operations",
          query: {
            includeArchived,
          },
        });
      },
      getRoleOperations: (roleId) => {
        transport.assertCapability("workers.getRoleOperations", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleOperationsDetail>("workers.getRoleOperations", {
          path: `/api/v1/roles/${encodeURIComponent(roleId)}/operations`,
        });
      },
      enqueueRoleWork: (input: RoleQueueEntryInput) => {
        transport.assertCapability("workers.enqueueRoleWork", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleQueueEntry>("workers.enqueueRoleWork", {
          method: "POST",
          path: "/api/v1/role-queue",
          body: input,
        });
      },
      dispatchRoleQueue: (roleId) => {
        transport.assertCapability("workers.dispatchRoleQueue", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleOperationsDetail>("workers.dispatchRoleQueue", {
          method: "POST",
          path: `/api/v1/roles/${encodeURIComponent(roleId)}/dispatch`,
        });
      },
      deleteRoleQueueEntry: (queueEntryId) => {
        transport.assertCapability("workers.deleteRoleQueueEntry", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleQueueEntry>("workers.deleteRoleQueueEntry", {
          method: "DELETE",
          path: `/api/v1/role-queue/${encodeURIComponent(queueEntryId)}`,
        });
      },
      resetRoleAssignments: (roleId) => {
        transport.assertCapability("workers.resetRoleAssignments", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleOperationsDetail>("workers.resetRoleAssignments", {
          method: "POST",
          path: `/api/v1/roles/${encodeURIComponent(roleId)}/reset-assignments`,
        });
      },
      releaseRoleInstance: (instanceId, outcome: OrchestraRoleInstanceReleaseOutcome, errorMessage) => {
        transport.assertCapability("workers.releaseRoleInstance", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleOperationsDetail>("workers.releaseRoleInstance", {
          method: "POST",
          path: `/api/v1/role-instances/${encodeURIComponent(instanceId)}/release`,
          body: {
            outcome,
            errorMessage: errorMessage ?? null,
          },
        });
      },
      disposeRoleInstance: (instanceId) => {
        transport.assertCapability("workers.disposeRoleInstance", bootstrap.capabilities.admin.workers);
        return transport.requestJson<RoleOperationsDetail>("workers.disposeRoleInstance", {
          method: "POST",
          path: `/api/v1/role-instances/${encodeURIComponent(instanceId)}/dispose`,
        });
      },
      getRolePermissions: (roleId) => {
        transport.assertCapability("workers.getRolePermissions", bootstrap.capabilities.admin.workers);
        return transport.requestJson<ResolvedPermissions>("workers.getRolePermissions", {
          path: `/api/v1/roles/${encodeURIComponent(roleId)}/permissions`,
        });
      },
    },
    workflows: {
      validateWorkflow: (input: WorkflowUpsertInput) => {
        transport.assertCapability("workflows.validateWorkflow", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowValidationResult>("workflows.validateWorkflow", {
          method: "POST",
          path: "/api/v1/workflows/validate",
          body: input,
        });
      },
      createWorkflow: (input: WorkflowUpsertInput) => {
        transport.assertCapability("workflows.createWorkflow", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowDefinition>("workflows.createWorkflow", {
          method: "POST",
          path: "/api/v1/workflows",
          body: input,
        });
      },
      updateWorkflow: (workflowId, input: WorkflowUpsertInput) => {
        transport.assertCapability("workflows.updateWorkflow", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowDefinition>("workflows.updateWorkflow", {
          method: "PATCH",
          path: `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
          body: input,
        });
      },
      duplicateWorkflow: (workflowId, newName) => {
        transport.assertCapability("workflows.duplicateWorkflow", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowDefinition>("workflows.duplicateWorkflow", {
          method: "POST",
          path: `/api/v1/workflows/${encodeURIComponent(workflowId)}/duplicate`,
          body: {
            newName: newName ?? null,
          },
        });
      },
      archiveWorkflow: (workflowId) => {
        transport.assertCapability("workflows.archiveWorkflow", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowDefinition>("workflows.archiveWorkflow", {
          method: "POST",
          path: `/api/v1/workflows/${encodeURIComponent(workflowId)}/archive`,
        });
      },
      getWorkflowDeleteImpact: (workflowId) => {
        transport.assertCapability("workflows.getWorkflowDeleteImpact", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowDeleteImpact>("workflows.getWorkflowDeleteImpact", {
          path: `/api/v1/workflows/${encodeURIComponent(workflowId)}/delete-impact`,
        });
      },
      deleteWorkflow: (workflowId) => {
        transport.assertCapability("workflows.deleteWorkflow", bootstrap.capabilities.admin.workflows);
        return transport.requestJson<WorkflowDeleteImpact>("workflows.deleteWorkflow", {
          method: "DELETE",
          path: `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
        });
      },
    },
    policies: {
      listPolicies: () => {
        transport.assertCapability("policies.listPolicies", bootstrap.capabilities.admin.policies);
        return transport.requestJson<PolicySummary[]>("policies.listPolicies", {
          path: "/api/v1/policies",
        });
      },
      getPolicy: (policyId) => {
        transport.assertCapability("policies.getPolicy", bootstrap.capabilities.admin.policies);
        return transport.requestJson<PolicyDefinition>("policies.getPolicy", {
          path: `/api/v1/policies/${encodeURIComponent(policyId)}`,
        });
      },
    },
    channels: {
      listChannels: () => {
        transport.assertCapability("channels.listChannels", bootstrap.capabilities.admin.channels);
        return transport.requestJson<ChannelSummary[]>("channels.listChannels", {
          path: "/api/v1/channels",
        });
      },
      getChannel: (channelId) => {
        transport.assertCapability("channels.getChannel", bootstrap.capabilities.admin.channels);
        return transport.requestJson<ChannelDetail>("channels.getChannel", {
          path: `/api/v1/channels/${encodeURIComponent(channelId)}`,
        });
      },
      listChannelActivity: (channelId, limit = 50) => {
        transport.assertCapability("channels.listChannelActivity", bootstrap.capabilities.admin.channels);
        return transport.requestJson<ChannelActivityEntry[]>("channels.listChannelActivity", {
          path: `/api/v1/channels/${encodeURIComponent(channelId)}/activity`,
          query: {
            limit,
          },
        });
      },
      createChannel: (input: ChannelUpsertInput) => {
        transport.assertCapability("channels.createChannel", bootstrap.capabilities.admin.channels);
        return transport.requestJson<ChannelDetail>("channels.createChannel", {
          method: "POST",
          path: "/api/v1/channels",
          body: input,
        });
      },
      updateChannel: (channelId, input: ChannelUpsertInput) => {
        transport.assertCapability("channels.updateChannel", bootstrap.capabilities.admin.channels);
        return transport.requestJson<ChannelDetail>("channels.updateChannel", {
          method: "PATCH",
          path: `/api/v1/channels/${encodeURIComponent(channelId)}`,
          body: input,
        });
      },
      deleteChannel: (channelId) => {
        transport.assertCapability("channels.deleteChannel", bootstrap.capabilities.admin.channels);
        return transport.requestVoid("channels.deleteChannel", {
          method: "DELETE",
          path: `/api/v1/channels/${encodeURIComponent(channelId)}`,
        });
      },
      validateTelegramBot: (botToken, apiBaseUrl) => {
        transport.assertCapability("channels.validateTelegramBot", bootstrap.capabilities.admin.channels);
        return transport.requestJson<TelegramBotValidation>("channels.validateTelegramBot", {
          method: "POST",
          path: "/api/v1/channels/telegram/validate-bot",
          body: {
            botToken,
            apiBaseUrl: apiBaseUrl ?? null,
          },
        });
      },
      listTelegramChatCandidates: (botToken, apiBaseUrl) => {
        transport.assertCapability("channels.listTelegramChatCandidates", bootstrap.capabilities.admin.channels);
        return transport.requestJson<TelegramChatCandidate[]>("channels.listTelegramChatCandidates", {
          method: "POST",
          path: "/api/v1/channels/telegram/chat-candidates",
          body: {
            botToken,
            apiBaseUrl: apiBaseUrl ?? null,
          },
        });
      },
    },
    tasks: {
      list: (options?: TaskListOptions) => {
        transport.assertCapability("tasks.list", bootstrap.capabilities.tasks.read);
        return transport.requestJson<TaskSummary[]>("tasks.list", {
          path: "/api/v1/tasks",
          query: createRemoteApiTaskListQuery(options),
        });
      },
      get: (taskId) => {
        transport.assertCapability("tasks.get", bootstrap.capabilities.tasks.read);
        return transport.requestJson<TaskDetail>("tasks.get", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}`,
        });
      },
      create: (input, projectId) => {
        transport.assertCapability("tasks.create", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.create", {
          method: "POST",
          path: "/api/v1/tasks",
          query: {
            projectId: projectId ?? undefined,
          },
          body: input,
        });
      },
      update: (taskId, input) => {
        transport.assertCapability("tasks.update", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.update", {
          method: "PATCH",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}`,
          body: input,
        });
      },
      remove: (taskId) => {
        transport.assertCapability("tasks.remove", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.remove", {
          method: "DELETE",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}`,
        });
      },
      listTodos: (taskId) => {
        transport.assertCapability("tasks.listTodos", bootstrap.capabilities.tasks.todos);
        return transport.requestJson<TaskTodo[]>("tasks.listTodos", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/todos`,
        });
      },
      listUnfinishedTodos: (taskId, laneId) => {
        transport.assertCapability("tasks.listUnfinishedTodos", bootstrap.capabilities.tasks.todos);
        return transport.requestJson<TaskTodo[]>("tasks.listUnfinishedTodos", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/todos/unfinished`,
          query: {
            laneId: laneId ?? undefined,
          },
        });
      },
      addTodo: (taskId, input) => {
        transport.assertCapability("tasks.addTodo", bootstrap.capabilities.tasks.todos);
        return transport.requestJson<TaskTodo>("tasks.addTodo", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/todos`,
          body: input,
        });
      },
      markTodoFinished: (todoId) => {
        transport.assertCapability("tasks.markTodoFinished", bootstrap.capabilities.tasks.todos);
        return transport.requestJson<TaskTodo>("tasks.markTodoFinished", {
          method: "POST",
          path: `/api/v1/task-todos/${encodeURIComponent(todoId)}/finish`,
        });
      },
      markTodoUnfinished: (todoId) => {
        transport.assertCapability("tasks.markTodoUnfinished", bootstrap.capabilities.tasks.todos);
        return transport.requestJson<TaskTodo>("tasks.markTodoUnfinished", {
          method: "POST",
          path: `/api/v1/task-todos/${encodeURIComponent(todoId)}/unfinish`,
        });
      },
      deleteTodo: (todoId) => {
        transport.assertCapability("tasks.deleteTodo", bootstrap.capabilities.tasks.todos);
        return transport.requestJson<TaskTodo>("tasks.deleteTodo", {
          method: "DELETE",
          path: `/api/v1/task-todos/${encodeURIComponent(todoId)}`,
        });
      },
      listComments: (taskId) => {
        transport.assertCapability("tasks.listComments", bootstrap.capabilities.tasks.comments);
        return transport.requestJson<TaskComment[]>("tasks.listComments", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/comments`,
        });
      },
      comment: (taskId, input) => {
        transport.assertCapability("tasks.comment", bootstrap.capabilities.tasks.comments);
        return transport.requestJson<TaskComment>("tasks.comment", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/comments`,
          body: input,
        });
      },
      updateComment: (commentId, input) => {
        transport.assertCapability("tasks.updateComment", bootstrap.capabilities.tasks.comments);
        return transport.requestJson<TaskComment>("tasks.updateComment", {
          method: "PATCH",
          path: `/api/v1/task-comments/${encodeURIComponent(commentId)}`,
          body: input,
        });
      },
      deleteComment: (commentId) => {
        transport.assertCapability("tasks.deleteComment", bootstrap.capabilities.tasks.comments);
        return transport.requestJson<TaskComment>("tasks.deleteComment", {
          method: "DELETE",
          path: `/api/v1/task-comments/${encodeURIComponent(commentId)}`,
        });
      },
      markCommentsRead: (taskId) => {
        transport.assertCapability("tasks.markCommentsRead", bootstrap.capabilities.tasks.comments);
        return transport.requestJson<TaskDetail>("tasks.markCommentsRead", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/comments/read`,
        });
      },
      searchCommentFileMentions: (taskId, query, limit = 10) => {
        transport.assertCapability("tasks.searchCommentFileMentions", bootstrap.capabilities.tasks.comments);
        return transport.requestJson<TaskCommentFileMentionCandidate[]>("tasks.searchCommentFileMentions", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/comment-file-mentions`,
          query: {
            query,
            limit,
          },
        });
      },
      listMessages: (taskId) => {
        transport.assertCapability("tasks.listMessages", bootstrap.capabilities.inbox.read);
        return transport.requestJson<MailboxMessage[]>("tasks.listMessages", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/messages`,
        });
      },
      addDependency: (blockerTaskId, blockedTaskId) => {
        transport.assertCapability("tasks.addDependency", bootstrap.capabilities.tasks.dependencies);
        return transport.requestJson<TaskDependency>("tasks.addDependency", {
          method: "POST",
          path: "/api/v1/task-dependencies",
          body: {
            blockerTaskId,
            blockedTaskId,
          },
        });
      },
      removeDependency: (dependencyId) => {
        transport.assertCapability("tasks.removeDependency", bootstrap.capabilities.tasks.dependencies);
        return transport.requestJson<TaskDependency>("tasks.removeDependency", {
          method: "DELETE",
          path: `/api/v1/task-dependencies/${encodeURIComponent(dependencyId)}`,
        });
      },
      listFileReferences: (taskId) => {
        transport.assertCapability("tasks.listFileReferences", bootstrap.capabilities.tasks.fileReferences);
        return transport.requestJson<TaskFileReference[]>("tasks.listFileReferences", {
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/file-references`,
        });
      },
      addFileReference: (taskId, input) => {
        transport.assertCapability("tasks.addFileReference", bootstrap.capabilities.tasks.fileReferences);
        return transport.requestJson<TaskFileReference>("tasks.addFileReference", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/file-references`,
          body: input,
        });
      },
      setDefaultFileReference: (referenceId) => {
        transport.assertCapability("tasks.setDefaultFileReference", bootstrap.capabilities.tasks.fileReferences);
        return transport.requestJson<TaskFileReference>("tasks.setDefaultFileReference", {
          method: "POST",
          path: `/api/v1/task-file-references/${encodeURIComponent(referenceId)}/default`,
        });
      },
      removeFileReference: (referenceId) => {
        transport.assertCapability("tasks.removeFileReference", bootstrap.capabilities.tasks.fileReferences);
        return transport.requestJson<TaskFileReference>("tasks.removeFileReference", {
          method: "DELETE",
          path: `/api/v1/task-file-references/${encodeURIComponent(referenceId)}`,
        });
      },
      getFileContent: (path) => {
        transport.assertCapability("tasks.getFileContent", bootstrap.capabilities.tasks.fileContents);
        return transport.requestText("tasks.getFileContent", {
          path: "/api/v1/task-file-content",
          query: {
            path,
          },
        });
      },
      addAttachment: (taskId, input) => {
        transport.assertCapability("tasks.addAttachment", bootstrap.capabilities.tasks.attachments);
        return transport.requestJson<TaskAttachment>("tasks.addAttachment", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/attachments`,
          body: input,
        });
      },
      removeAttachment: (attachmentId) => {
        transport.assertCapability("tasks.removeAttachment", bootstrap.capabilities.tasks.attachments);
        return transport.requestJson<TaskAttachment>("tasks.removeAttachment", {
          method: "DELETE",
          path: `/api/v1/task-attachments/${encodeURIComponent(attachmentId)}`,
        });
      },
      listSchedules: (projectId) => {
        transport.assertCapability("tasks.listSchedules", bootstrap.capabilities.tasks.schedules);
        return transport.requestJson<TaskScheduleSummary[]>("tasks.listSchedules", {
          path: "/api/v1/task-schedules",
          query: {
            projectId: projectId ?? undefined,
          },
        });
      },
      getSchedule: (scheduleId) => {
        transport.assertCapability("tasks.getSchedule", bootstrap.capabilities.tasks.schedules);
        return transport.requestJson<TaskScheduleDetail>("tasks.getSchedule", {
          path: `/api/v1/task-schedules/${encodeURIComponent(scheduleId)}`,
        });
      },
      createSchedule: (input, projectId) => {
        transport.assertCapability("tasks.createSchedule", bootstrap.capabilities.tasks.schedules);
        return transport.requestJson<TaskScheduleDetail>("tasks.createSchedule", {
          method: "POST",
          path: "/api/v1/task-schedules",
          query: {
            projectId: projectId ?? undefined,
          },
          body: input,
        });
      },
      updateSchedule: (scheduleId, input) => {
        transport.assertCapability("tasks.updateSchedule", bootstrap.capabilities.tasks.schedules);
        return transport.requestJson<TaskScheduleDetail>("tasks.updateSchedule", {
          method: "PATCH",
          path: `/api/v1/task-schedules/${encodeURIComponent(scheduleId)}`,
          body: input,
        });
      },
      deleteSchedule: (scheduleId) => {
        transport.assertCapability("tasks.deleteSchedule", bootstrap.capabilities.tasks.schedules);
        return transport.requestJson<TaskScheduleDetail>("tasks.deleteSchedule", {
          method: "DELETE",
          path: `/api/v1/task-schedules/${encodeURIComponent(scheduleId)}`,
        });
      },
      dispatch: (taskId) => {
        transport.assertCapability("tasks.dispatch", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.dispatch", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/dispatch`,
        });
      },
      complete: (taskId, outcome, notes) => {
        transport.assertCapability("tasks.complete", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>(`tasks.complete.${outcome}`, {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/complete/${mapCompletionOutcomeToPath(outcome)}`,
          body: createNotesBody(notes),
        });
      },
      approveReview: (taskId) => {
        transport.assertCapability("tasks.approveReview", bootstrap.capabilities.tasks.review);
        return transport.requestJson<TaskDetail>("tasks.approveReview", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/approve-review`,
        });
      },
      approveCompletion: (taskId) => {
        transport.assertCapability("tasks.approveCompletion", bootstrap.capabilities.tasks.review);
        return transport.requestJson<TaskDetail>("tasks.approveCompletion", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/approve-completion`,
        });
      },
      markNeedsWork: (taskId, notes) => {
        transport.assertCapability("tasks.markNeedsWork", bootstrap.capabilities.tasks.review);
        return transport.requestJson<TaskDetail>("tasks.markNeedsWork", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/needs-work`,
          body: createNotesBody(notes),
        });
      },
      resume: (taskId, notes) => {
        transport.assertCapability("tasks.resume", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.resume", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/resume`,
          body: createNotesBody(notes),
        });
      },
      pause: (taskId, notes) => {
        transport.assertCapability("tasks.pause", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.pause", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/pause`,
          body: createNotesBody(notes),
        });
      },
      stopActivity: (taskId, notes) => {
        transport.assertCapability("tasks.stopActivity", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.stopActivity", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/stop-activity`,
          body: createNotesBody(notes),
        });
      },
      reassign: (taskId, laneId, notes) => {
        transport.assertCapability("tasks.reassign", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.reassign", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/reassign`,
          body: {
            laneId,
            notes,
          },
        });
      },
      manualWhip: (taskId) => {
        transport.assertCapability("tasks.manualWhip", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.manualWhip", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/manual-whip`,
        });
      },
      resetRuntime: (taskId) => {
        transport.assertCapability("tasks.resetRuntime", bootstrap.capabilities.tasks.write);
        return transport.requestJson<TaskDetail>("tasks.resetRuntime", {
          method: "POST",
          path: `/api/v1/tasks/${encodeURIComponent(taskId)}/reset-runtime`,
        });
      },
    },
    inbox: {
      list: (projectId, includeArchived = false) => {
        transport.assertCapability("inbox.list", bootstrap.capabilities.inbox.read);
        return transport.requestJson<MailboxMessage[]>("inbox.list", {
          path: "/api/v1/inbox",
          query: {
            projectId: projectId ?? undefined,
            includeArchived,
          },
        });
      },
      send: (input) => {
        transport.assertCapability("inbox.send", bootstrap.capabilities.inbox.write);
        return transport.requestJson<MailboxMessage>("inbox.send", {
          method: "POST",
          path: "/api/v1/inbox/send",
          body: input,
        });
      },
      markRead: (input) => {
        transport.assertCapability("inbox.markRead", bootstrap.capabilities.inbox.read);
        return transport.requestJson<MailboxMessage[]>("inbox.markRead", {
          method: "POST",
          path: "/api/v1/inbox/read",
          body: input,
        });
      },
      archive: (input) => {
        transport.assertCapability("inbox.archive", bootstrap.capabilities.inbox.archive);
        return transport.requestJson<MailboxMessage[]>("inbox.archive", {
          method: "POST",
          path: "/api/v1/inbox/archive",
          body: input,
        });
      },
    },
    sessions: {
      list: (projectId) => {
        transport.assertCapability("sessions.list", bootstrap.capabilities.sessions.read);
        return transport.requestJson<SessionRecord[]>("sessions.list", {
          path: "/api/v1/sessions",
          query: {
            projectId: projectId ?? undefined,
          },
        });
      },
      get: (sessionId) => {
        transport.assertCapability("sessions.get", bootstrap.capabilities.sessions.read);
        return transport.requestJson<SessionRecord>("sessions.get", {
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        });
      },
      getRuntimeDetails: (sessionId) => {
        transport.assertCapability("sessions.getRuntimeDetails", bootstrap.capabilities.sessions.read);
        return transport.requestJson<SessionRuntimeDetails>("sessions.getRuntimeDetails", {
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/runtime`,
        });
      },
      getStats: (sessionId) => {
        transport.assertCapability("sessions.getStats", bootstrap.capabilities.sessions.read);
        return transport.requestJson<SessionStats>("sessions.getStats", {
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/stats`,
        });
      },
      create: (title, projectSlug) => {
        transport.assertCapability("sessions.create", bootstrap.capabilities.sessions.write);
        return transport.requestJson<SessionRecord>("sessions.create", {
          method: "POST",
          path: "/api/v1/sessions",
          body: {
            title,
            projectSlug,
          },
        });
      },
      createContextual: (sessionId, projectSlug) => {
        transport.assertCapability("sessions.createContextual", bootstrap.capabilities.sessions.write);
        return transport.requestJson<SessionRecord>("sessions.createContextual", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/contextual`,
          body: {
            projectSlug,
          },
        });
      },
      remove: async (sessionId) => {
        transport.assertCapability("sessions.remove", bootstrap.capabilities.sessions.write);
        await transport.requestVoid("sessions.remove", {
          method: "DELETE",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        });
      },
      resume: (sessionId) => {
        transport.assertCapability("sessions.resume", bootstrap.capabilities.sessions.write);
        return transport.requestJson<SessionRecord>("sessions.resume", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`,
        });
      },
      subscribe: async (sessionId) => {
        transport.assertCapability("sessions.subscribe", bootstrap.capabilities.sessions.write);
        const record = await transport.requestJson<SessionRecord>("sessions.subscribe", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/subscribe`,
        });
        await eventManager.confirmSessionSubscription(sessionId, true);
        return record;
      },
      unsubscribe: async (sessionId) => {
        transport.assertCapability("sessions.unsubscribe", bootstrap.capabilities.sessions.write);
        const record = await transport.requestJson<SessionRecord>("sessions.unsubscribe", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/unsubscribe`,
        });
        await eventManager.confirmSessionSubscription(sessionId, false);
        return record;
      },
      stopRuntime: (sessionId, notes) => {
        transport.assertCapability("sessions.stopRuntime", bootstrap.capabilities.sessions.runtimeControls);
        return transport.requestJson<SessionRecord>("sessions.stopRuntime", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/stop`,
          body: createNotesBody(notes),
        });
      },
      getModelState: (sessionId) => {
        transport.assertCapability("sessions.getModelState", bootstrap.capabilities.sessions.modelSelection);
        return transport.requestJson<SessionModelState>("sessions.getModelState", {
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/model`,
        });
      },
      setModel: (sessionId, provider, modelId) => {
        transport.assertCapability("sessions.setModel", bootstrap.capabilities.sessions.modelSelection);
        return transport.requestJson<SessionModelState>("sessions.setModel", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/model`,
          body: {
            provider,
            modelId,
          },
        });
      },
      compact: (sessionId, customInstructions) => {
        transport.assertCapability("sessions.compact", bootstrap.capabilities.sessions.runtimeControls);
        return transport.requestJson<SessionRecord>("sessions.compact", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
          body: {
            customInstructions,
          },
        });
      },
      reload: (sessionId) => {
        transport.assertCapability("sessions.reload", bootstrap.capabilities.sessions.runtimeControls);
        return transport.requestJson<SessionRecord>("sessions.reload", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/reload`,
        });
      },
      sendMessage: (sessionId, message, runId) => {
        transport.assertCapability("sessions.sendMessage", bootstrap.capabilities.sessions.write);
        return transport.requestJson<QueuedSessionMessage>("sessions.sendMessage", {
          method: "POST",
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/message`,
          body: {
            message,
            runId,
          },
        });
      },
    },
    events: {
      subscribe: (handler) => eventManager.subscribe(handler),
    },
    connection: connectionController,
    notifications: createLocalNotificationsExtension(),
  };

  return {
    client,
    bootstrap,
  };
}

function mapCompletionOutcomeToPath(outcome: OrchestraTaskCompletionOutcome) {
  switch (outcome) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "needs_user":
      return "needs-user";
    default:
      return "needs-user";
  }
}
