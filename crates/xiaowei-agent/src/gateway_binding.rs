// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_desktop_settings_service {
    pub const GET: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.Get", xw_gateway::MethodKind::Unary);
    pub const UPDATE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::UpdateSettingsRequest, proto_desktop_rs::xiaowei::desktop::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.Update", xw_gateway::MethodKind::Unary);
    pub const GET_WEB_SEARCH_RUNTIME_CONFIG: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::GetWebSearchRuntimeConfigRequest, proto_desktop_rs::xiaowei::desktop::WebSearchRuntimeConfig> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.GetWebSearchRuntimeConfig", xw_gateway::MethodKind::Unary);
    pub const TEST_WEB_SEARCH_PROVIDER: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::TestWebSearchProviderRequest, proto_desktop_rs::xiaowei::desktop::WebSearchProviderTestResult> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.TestWebSearchProvider", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_agent_agent_service {
    pub const CREATE_SESSION: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::CreateSessionRequest, proto_agent_rs::xiaowei::agent::CreateSessionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.CreateSession", xw_gateway::MethodKind::Unary);
    pub const LIST_SESSIONS: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::ListSessionsRequest, proto_agent_rs::xiaowei::agent::ListSessionsResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.ListSessions", xw_gateway::MethodKind::Unary);
    pub const READ_SESSION: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::ReadSessionRequest, proto_agent_rs::xiaowei::agent::ReadSessionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.ReadSession", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_CONFIG: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::SetSessionConfigRequest, proto_agent_rs::xiaowei::agent::SetSessionConfigResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionConfig", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_TITLE: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::SetSessionTitleRequest, proto_agent_rs::xiaowei::agent::SetSessionTitleResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionTitle", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_ARCHIVED: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::SetSessionArchivedRequest, proto_agent_rs::xiaowei::agent::SetSessionArchivedResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionArchived", xw_gateway::MethodKind::Unary);
    pub const DELETE_SESSION: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::DeleteSessionRequest, proto_agent_rs::xiaowei::agent::DeleteSessionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.DeleteSession", xw_gateway::MethodKind::Unary);
    pub const SUBSCRIBE_SESSION: xw_gateway::binding::StreamMethod<proto_agent_rs::xiaowei::agent::SubscribeSessionRequest, proto_agent_rs::xiaowei::agent::AgentEvent> =
        xw_gateway::binding::StreamMethod::new("xiaowei.agent.Agent.SubscribeSession");
    pub const TRACK_SESSION_VIEWING: xw_gateway::binding::StreamMethod<proto_agent_rs::xiaowei::agent::TrackSessionViewingRequest, proto_agent_rs::xiaowei::agent::SessionViewingReady> =
        xw_gateway::binding::StreamMethod::new("xiaowei.agent.Agent.TrackSessionViewing");
    pub const START_RUN: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::StartRunRequest, proto_agent_rs::xiaowei::agent::StartRunResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.StartRun", xw_gateway::MethodKind::Unary);
    pub const INTERRUPT_RUN: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::InterruptRunRequest, proto_agent_rs::xiaowei::agent::InterruptRunResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.InterruptRun", xw_gateway::MethodKind::Unary);
    pub const OBSERVE_INTERACTIONS: xw_gateway::binding::StreamMethod<proto_agent_rs::xiaowei::agent::ObserveInteractionsRequest, proto_agent_rs::xiaowei::agent::InteractionDeliveryEvent> =
        xw_gateway::binding::StreamMethod::new("xiaowei.agent.Agent.ObserveInteractions");
    pub const ACKNOWLEDGE_INTERACTION: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::AcknowledgeInteractionRequest, proto_agent_rs::xiaowei::agent::AcknowledgeInteractionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.AcknowledgeInteraction", xw_gateway::MethodKind::Unary);
    pub const RESPOND_INTERACTION: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::RespondInteractionRequest, proto_agent_rs::xiaowei::agent::RespondInteractionResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.RespondInteraction", xw_gateway::MethodKind::Unary);
    pub const REGENERATE_TITLE: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::RegenerateTitleRequest, proto_agent_rs::xiaowei::agent::RegenerateTitleResponse> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.RegenerateTitle", xw_gateway::MethodKind::Unary);
    pub const GET_SESSION_RETENTION_POLICY: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::GetSessionRetentionPolicyRequest, proto_agent_rs::xiaowei::agent::SessionRetentionPolicy> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.GetSessionRetentionPolicy", xw_gateway::MethodKind::Unary);
    pub const SET_SESSION_RETENTION_POLICY: xw_gateway::binding::Method<proto_agent_rs::xiaowei::agent::SetSessionRetentionPolicyRequest, proto_agent_rs::xiaowei::agent::SessionRetentionPolicy> =
        xw_gateway::binding::Method::new("xiaowei.agent.Agent.SetSessionRetentionPolicy", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_llm_llm_service {
    pub const GENERATE: xw_gateway::binding::StreamMethod<proto_llm_rs::xiaowei::llm::GenerateRequest, proto_llm_rs::xiaowei::llm::GenerateEvent> =
        xw_gateway::binding::StreamMethod::new("xiaowei.llm.Llm.Generate");
    pub const SET_MODELS: xw_gateway::binding::Method<proto_llm_rs::xiaowei::llm::SetModelsRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.llm.Llm.SetModels", xw_gateway::MethodKind::Unary);
    pub const GET_MODEL_INFO: xw_gateway::binding::Method<proto_llm_rs::xiaowei::llm::GetModelInfoRequest, proto_llm_rs::xiaowei::llm::ModelInfo> =
        xw_gateway::binding::Method::new("xiaowei.llm.Llm.GetModelInfo", xw_gateway::MethodKind::Unary);
    pub const MODEL_CATALOG: xw_gateway::binding::StreamMethod<proto_llm_rs::xiaowei::llm::ListModelsRequest, proto_llm_rs::xiaowei::llm::ListModelsResponse> =
        xw_gateway::binding::StreamMethod::new("xiaowei.llm.Llm.ModelCatalog");
}
#[rustfmt::skip]
pub mod xiaowei_llm_model_settings_service {
    pub const GET: xw_gateway::binding::Method<(), proto_llm_rs::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.Get", xw_gateway::MethodKind::Unary);
    pub const GET_AUXILIARY_MODEL_REF: xw_gateway::binding::Method<(), proto_llm_rs::xiaowei::llm::AuxiliaryModelRef> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.GetAuxiliaryModelRef", xw_gateway::MethodKind::Unary);
    pub const SAVE_PROVIDER: xw_gateway::binding::Method<proto_llm_rs::xiaowei::llm::SaveProviderRequest, proto_llm_rs::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.SaveProvider", xw_gateway::MethodKind::Unary);
    pub const DELETE_PROVIDER: xw_gateway::binding::Method<proto_llm_rs::xiaowei::llm::DeleteProviderRequest, proto_llm_rs::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.DeleteProvider", xw_gateway::MethodKind::Unary);
    pub const UPDATE_DEFAULTS: xw_gateway::binding::Method<proto_llm_rs::xiaowei::llm::UpdateModelDefaultsRequest, proto_llm_rs::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.UpdateDefaults", xw_gateway::MethodKind::Unary);
    pub const LIST_MODELS: xw_gateway::binding::StreamMethod<proto_llm_rs::xiaowei::llm::DiscoverModelsRequest, proto_llm_rs::xiaowei::llm::ListModelsResponse> =
        xw_gateway::binding::StreamMethod::new("xiaowei.llm.ModelSettings.ListModels");
    pub const REAPPLY: xw_gateway::binding::Method<(), proto_llm_rs::xiaowei::llm::ModelSettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.llm.ModelSettings.Reapply", xw_gateway::MethodKind::Unary);
}
