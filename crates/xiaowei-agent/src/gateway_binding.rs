// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_agent_agent_service {
    pub const CREATE_SESSION: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::CreateSessionRequest, xw_contracts::xiaowei::agent::CreateSessionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.CreateSession", xw_gateway::MethodKind::Unary);
    pub const LIST_SESSIONS: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::ListSessionsRequest, xw_contracts::xiaowei::agent::ListSessionsResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.ListSessions", xw_gateway::MethodKind::Unary);
    pub const READ_SESSION: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::ReadSessionRequest, xw_contracts::xiaowei::agent::ReadSessionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.ReadSession", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_CONFIG: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::SetSessionConfigRequest, xw_contracts::xiaowei::agent::SetSessionConfigResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionConfig", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_TITLE: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::SetSessionTitleRequest, xw_contracts::xiaowei::agent::SetSessionTitleResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionTitle", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_ARCHIVED: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::SetSessionArchivedRequest, xw_contracts::xiaowei::agent::SetSessionArchivedResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionArchived", xw_gateway::MethodKind::Unary);
    pub const DELETE_SESSION: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::DeleteSessionRequest, xw_contracts::xiaowei::agent::DeleteSessionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.DeleteSession", xw_gateway::MethodKind::Unary);
    pub const SUBSCRIBE_SESSION: xw_gateway::binding::StreamMethod<xw_contracts::xiaowei::agent::SubscribeSessionRequest, xw_contracts::xiaowei::agent::AgentEvent> =
        xw_gateway::binding::StreamMethod::new("xiaowei.agent.Agent.SubscribeSession");
    pub const TRACK_SESSION_VIEWING: xw_gateway::binding::StreamMethod<xw_contracts::xiaowei::agent::TrackSessionViewingRequest, xw_contracts::xiaowei::agent::SessionViewingReady> =
        xw_gateway::binding::StreamMethod::new("xiaowei.agent.Agent.TrackSessionViewing");
    pub const START_RUN: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::StartRunRequest, xw_contracts::xiaowei::agent::StartRunResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.StartRun", xw_gateway::MethodKind::Unary);
    pub const INTERRUPT_RUN: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::InterruptRunRequest, xw_contracts::xiaowei::agent::InterruptRunResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.InterruptRun", xw_gateway::MethodKind::Unary);
    pub const REGENERATE_TITLE: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::RegenerateTitleRequest, xw_contracts::xiaowei::agent::RegenerateTitleResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.RegenerateTitle", xw_gateway::MethodKind::Unary);
    pub const GET_SESSION_RETENTION_POLICY: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::GetSessionRetentionPolicyRequest, xw_contracts::xiaowei::agent::SessionRetentionPolicy> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.GetSessionRetentionPolicy", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_RETENTION_POLICY: xw_gateway::binding::Method<xw_contracts::xiaowei::agent::SetSessionRetentionPolicyRequest, xw_contracts::xiaowei::agent::SessionRetentionPolicy> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionRetentionPolicy", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_llm_llm_service {
    pub const GENERATE: xw_gateway::binding::StreamMethod<xw_contracts::xiaowei::llm::GenerateRequest, xw_contracts::xiaowei::llm::GenerateEvent> =
        xw_gateway::binding::StreamMethod::new("xiaowei.llm.Llm.Generate");
    pub const SET_MODELS: xw_gateway::binding::Method<xw_contracts::xiaowei::llm::SetModelsRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.llm.Llm.SetModels", xw_gateway::MethodKind::Unary);
    pub const GET_MODEL_INFO: xw_gateway::binding::Method<xw_contracts::xiaowei::llm::GetModelInfoRequest, xw_contracts::xiaowei::llm::ModelInfo> =
        xw_gateway::binding::Method::new("xiaowei.llm.Llm.GetModelInfo", xw_gateway::MethodKind::Unary);
    pub const MODEL_CATALOG: xw_gateway::binding::StreamMethod<xw_contracts::xiaowei::llm::ListModelsRequest, xw_contracts::xiaowei::llm::ListModelsResponse> =
        xw_gateway::binding::StreamMethod::new("xiaowei.llm.Llm.ModelCatalog");
}
#[rustfmt::skip]
pub mod xiaowei_llm_model_settings_service {
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.Get", xw_gateway::MethodKind::Unary);
    pub const GET_AUXILIARY_MODEL_REF: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::llm::AuxiliaryModelRef> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.GetAuxiliaryModelRef", xw_gateway::MethodKind::Unary);
    pub const SAVE_PROVIDER: xw_gateway::binding::Method<xw_contracts::xiaowei::llm::SaveProviderRequest, xw_contracts::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.SaveProvider", xw_gateway::MethodKind::Unary);
    pub const DELETE_PROVIDER: xw_gateway::binding::Method<xw_contracts::xiaowei::llm::DeleteProviderRequest, xw_contracts::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.DeleteProvider", xw_gateway::MethodKind::Unary);
    pub const UPDATE_DEFAULTS: xw_gateway::binding::Method<xw_contracts::xiaowei::llm::UpdateModelDefaultsRequest, xw_contracts::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.UpdateDefaults", xw_gateway::MethodKind::Unary);
    pub const LIST_MODELS: xw_gateway::binding::StreamMethod<xw_contracts::xiaowei::llm::DiscoverModelsRequest, xw_contracts::xiaowei::llm::ListModelsResponse> =
        xw_gateway::binding::StreamMethod::new("xiaowei.llm.ModelSettings.ListModels");
    pub const REAPPLY: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.Reapply", xw_gateway::MethodKind::Unary);
}
