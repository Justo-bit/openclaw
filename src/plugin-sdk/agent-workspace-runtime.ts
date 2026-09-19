// Workspace access registration without loading agent execution runtime.
export { createWorkspaceAttachmentPreparer } from "../agents/workspace-attachment-preparer.js";
export {
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
  prepareAgentWorkspaceAttachments,
  type AgentWorkspaceAccess,
} from "../agents/workspace-access.js";
